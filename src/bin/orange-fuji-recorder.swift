// orange-fuji-recorder — Native macOS screen recorder CLI
//
// Records the screen at NATIVE physical pixel resolution (Retina-aware) using
// ScreenCaptureKit, encoding H.264 (+AAC system audio) into MP4 via AVAssetWriter.
// This is the quality path that Chromium's getDisplayMedia cannot provide:
// Chromium caps desktop capture frames at the display's logical (scaled) UI
// resolution, while ScreenCaptureKit delivers full panel resolution.
//
// Usage:
//   orange-fuji-recorder --out PATH [--display ID] [--region x,y,w,h]
//                       [--fps N] [--no-audio] [--bitrate N]
//
// Protocol (stdout, one JSON object per line):
//   {"event":"ready","width":W,"height":H,"fps":F,"audio":true}
//   {"event":"started"}
//   {"event":"stopped","file":"PATH","duration":S}
//   {"event":"error","message":"..."}
//
// Stop gracefully with SIGTERM or SIGINT; the MP4 is finalized before exit.

import Foundation
import CoreGraphics
import ScreenCaptureKit
import AVFoundation

// MARK: - Args

struct Args {
    var out: String = ""
    var displayID: CGDirectDisplayID?
    var region: CGRect?
    var fps: Int32 = 60
    var audio: Bool = true
    var bitrate: Int64 = 0 // 0 = auto
}

func fail(_ message: String) -> Never {
    let data = try? JSONSerialization.data(withJSONObject: ["event": "error", "message": message])
    if let data { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0A])) }
    exit(1)
}

func parseArgs() -> Args {
    var args = Args()
    var it = CommandLine.arguments.makeIterator()
    _ = it.next()
    while let arg = it.next() {
        switch arg {
        case "--out":
            guard let v = it.next() else { fail("missing value for --out") }
            args.out = v
        case "--display":
            guard let v = it.next(), let id = UInt32(v) else { fail("missing/invalid --display") }
            args.displayID = CGDirectDisplayID(id)
        case "--region":
            guard let v = it.next() else { fail("missing value for --region") }
            let parts = v.split(separator: ",").compactMap { Double($0) }
            guard parts.count == 4 else { fail("--region expects x,y,w,h") }
            args.region = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
        case "--fps":
            guard let v = it.next(), let f = Int32(v), f > 0, f <= 120 else { fail("invalid --fps") }
            args.fps = f
        case "--no-audio":
            args.audio = false
        case "--bitrate":
            guard let v = it.next(), let b = Int64(v), b > 0 else { fail("invalid --bitrate") }
            args.bitrate = b
        default:
            fail("unknown argument \(arg)")
        }
    }
    if args.out.isEmpty { fail("--out is required") }
    return args
}

func emit(_ payload: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: payload) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

// MARK: - Recorder

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
    let args: Args
    var stream: SCStream?
    var writer: AVAssetWriter?
    var videoInput: AVAssetWriterInput!
    var audioInput: AVAssetWriterInput?
    var sessionStartPTS: CMTime?
    var sawVideo = false
    var stopped = false
    let lock = NSLock()

    init(args: Args) { self.args = args }

    func run() {
        let semaphore = DispatchSemaphore(value: 0)
        SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
            defer { semaphore.signal() }
            if let error { fail("SCGetShareableContent failed: \(error.localizedDescription)") }
            guard let content else { fail("no shareable content") }

            let display: SCDisplay
            if let id = self.args.displayID,
               let match = content.displays.first(where: { $0.displayID == id }) {
                display = match
            } else if let first = content.displays.first {
                display = first
            } else {
                fail("no displays available for capture")
            }

            // Region capture is done via SCStreamConfiguration.sourceRect
            // (points relative to the display) on top of a full-display filter.
            let filter = SCContentFilter(display: display, excludingWindows: [])

            // pointPixelScale is macOS 14+; derive the same value from the
            // physical pixel width on older systems.
            let scale: CGFloat
            if #available(macOS 14.0, *) {
                scale = CGFloat(filter.pointPixelScale)
            } else {
                let physicalWidth = CGFloat(CGDisplayPixelsWide(display.displayID))
                scale = physicalWidth > 0 && display.width > 0 ? physicalWidth / CGFloat(display.width) : 2.0
            }
            let rect: CGRect
            if let region = self.args.region {
                rect = region
            } else if #available(macOS 14.0, *) {
                rect = filter.contentRect
            } else {
                rect = CGRect(x: 0, y: 0, width: display.width, height: display.height)
            }
            let pixelWidth = max(2, Int(rect.width * scale))
            let pixelHeight = max(2, Int(rect.height * scale))

            let config = SCStreamConfiguration()
            config.width = pixelWidth
            config.height = pixelHeight
            if let region = self.args.region {
                config.sourceRect = region
            }
            config.minimumFrameInterval = CMTime(value: 1, timescale: self.args.fps)
            config.queueDepth = 12
            config.showsCursor = true
            var audioEnabled = false
            if #available(macOS 13.0, *) {
                config.capturesAudio = self.args.audio
                audioEnabled = config.capturesAudio
                if audioEnabled {
                    config.sampleRate = 48000
                    config.channelCount = 2
                }
            }
            config.colorSpaceName = CGColorSpace.sRGB

            let autoBitrate = Double(pixelWidth) * Double(pixelHeight) * Double(self.args.fps) * 0.12
            let bitrate = self.args.bitrate > 0 ? self.args.bitrate : Int64(autoBitrate)
            let clampedBitrate = min(max(bitrate, 20_000_000), 100_000_000)

            do {
                self.writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: self.args.out), fileType: .mp4)
            } catch {
                fail("AVAssetWriter init failed: \(error.localizedDescription)")
            }

            self.videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: pixelWidth,
                AVVideoHeightKey: pixelHeight,
                AVVideoCompressionPropertiesKey: [
                    AVVideoAverageBitRateKey: clampedBitrate,
                    AVVideoExpectedSourceFrameRateKey: NSNumber(value: self.args.fps),
                    AVVideoMaxKeyFrameIntervalKey: NSNumber(value: self.args.fps * 2),
                    AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                ],
            ])
            self.videoInput.expectsMediaDataInRealTime = true
            if self.writer!.canAdd(self.videoInput) { self.writer!.add(self.videoInput) }

            if audioEnabled {
                self.audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                    AVFormatIDKey: kAudioFormatMPEG4AAC,
                    AVNumberOfChannelsKey: 2,
                    AVSampleRateKey: 48000,
                    AVEncoderBitRateKey: 192_000,
                ])
                self.audioInput?.expectsMediaDataInRealTime = true
                if let audioInput = self.audioInput, self.writer!.canAdd(audioInput) {
                    self.writer!.add(audioInput)
                } else {
                    self.audioInput = nil
                }
            }

            emit(["event": "ready", "width": pixelWidth, "height": pixelHeight,
                  "fps": self.args.fps, "audio": audioEnabled])

            let stream = SCStream(filter: filter, configuration: config, delegate: self)
            do {
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "of.video"))
            } catch {
                fail("addStreamOutput(video) failed: \(error.localizedDescription)")
            }
            if audioEnabled {
                if #available(macOS 13.0, *) {
                    do {
                        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: DispatchQueue(label: "of.audio"))
                    } catch {
                        fail("addStreamOutput(audio) failed: \(error.localizedDescription)")
                    }
                }
            }
            stream.startCapture { error in
                if let error { fail("startCapture failed: \(error.localizedDescription)") }
                emit(["event": "started"])
            }
            self.stream = stream
        }
        semaphore.wait()
    }

    func stop() {
        lock.lock()
        if stopped { lock.unlock(); return }
        stopped = true
        let streamReady = stream
        lock.unlock()

        guard let stream = streamReady else {
            // Signal arrived before the stream existed: nothing to finalize.
            emit(["event": "stopped", "file": args.out, "duration": 0.0])
            exit(0)
        }
        stream.stopCapture { _ in
            try? stream.removeStreamOutput(self, type: .screen)
            if self.audioInput != nil {
                if #available(macOS 13.0, *) {
                    try? stream.removeStreamOutput(self, type: .audio)
                }
            }
            self.finishWriting()
        }
    }

    func finishWriting() {
        guard let writer else { exit(1) }
        videoInput.markAsFinished()
        audioInput?.markAsFinished()
        writer.finishWriting {
            var fileDuration = 0.0
            if let asset = AVURLAsset(url: writer.outputURL).tracks(withMediaType: .video).first {
                fileDuration = CMTimeGetSeconds(asset.timeRange.duration)
            }
            emit(["event": "stopped", "file": writer.outputURL.path, "duration": fileDuration])
            exit(writer.status == .completed ? 0 : 1)
        }
    }

    // MARK: SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopped, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let flagsRaw = attachments.first?[.status] as? Int,
              let status = SCFrameStatus(rawValue: flagsRaw), status == .complete else { return }

        switch type {
        case .screen:
            guard let writer, let videoInput else { return }
            if writer.status == .unknown {
                if !writer.startWriting() { fail("startWriting failed") }
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                writer.startSession(atSourceTime: pts)
                sessionStartPTS = pts
            }
            if writer.status == .writing {
                if !sawVideo {
                    sawVideo = true
                }
                if !videoInput.append(sampleBuffer) {
                    emit(["event": "error", "message": "append(video) failed: \(String(describing: writer.error?.localizedDescription))"])
                }
            }
        case .audio:
            if #available(macOS 13.0, *) {
                guard let writer, let audioInput else { return }
                if writer.status == .writing, !audioInput.append(sampleBuffer) {
                    // Audio append failures are non-fatal; keep recording video.
                }
            }
        default:
            break
        }
    }
}

// MARK: - Signals + main

let recorder = Recorder(args: parseArgs())

var signalSources: [DispatchSourceSignal] = []
let signalQueue = DispatchQueue(label: "of.signals")
for sig in [SIGINT, SIGTERM] {
    signal(sig, SIG_IGN)
    let source = DispatchSource.makeSignalSource(signal: sig, queue: signalQueue)
    source.setEventHandler { recorder.stop() }
    source.resume()
    signalSources.append(source)
}

recorder.run()

dispatchMain()
