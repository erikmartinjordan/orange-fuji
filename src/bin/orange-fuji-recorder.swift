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
//                       [--cursor normal|hidden|large]
//
// `--cursor hidden` omits the pointer from the capture. `--cursor large`
// omits the system pointer and composites a larger synthetic one at 60 fps so
// it keeps moving even when the rest of the screen is static.
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
import CoreMedia
import QuartzCore
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
    var cursor: String = "normal" // normal | hidden | large
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
        case "--cursor":
            guard let v = it.next(), ["normal", "hidden", "large"].contains(v) else { fail("invalid --cursor") }
            args.cursor = v
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

    // Cursor compositing state (only used when args.cursor == "large").
    let videoQueue = DispatchQueue(label: "of.video")
    var pointPixelScale: CGFloat = 1
    var displayFrame: CGRect = .zero
    var captureRect: CGRect = .zero
    var latestFrame: CVPixelBuffer?
    var sessionStartHost: CFTimeInterval?
    var largeCursorTimer: DispatchSourceTimer?

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
            config.showsCursor = self.args.cursor == "normal"
            config.pixelFormat = kCVPixelFormatType_32BGRA
            self.pointPixelScale = scale
            self.displayFrame = display.frame
            self.captureRect = rect
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
                try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.videoQueue)
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
        largeCursorTimer?.cancel()
        largeCursorTimer = nil
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

    // MARK: Cursor compositing (large cursor mode)

    func cursorPixelPosition() -> CGPoint? {
        guard let event = CGEvent(source: nil) else { return nil }
        let localX = event.location.x - displayFrame.origin.x - captureRect.origin.x
        let localY = event.location.y - displayFrame.origin.y - captureRect.origin.y
        guard localX >= 0, localY >= 0,
              localX <= captureRect.width, localY <= captureRect.height else { return nil }
        return CGPoint(x: localX * pointPixelScale, y: localY * pointPixelScale)
    }

    func copyPixelBuffer(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source)
        let height = CVPixelBufferGetHeight(source)
        let format = CVPixelBufferGetPixelFormatType(source)
        var destination: CVPixelBuffer?
        let attrs = [kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary] as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, format, attrs, &destination) == kCVReturnSuccess,
              let destination else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(destination, [])
        defer {
            CVPixelBufferUnlockBaseAddress(destination, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        guard let src = CVPixelBufferGetBaseAddress(source),
              let dst = CVPixelBufferGetBaseAddress(destination) else { return nil }
        let srcStride = CVPixelBufferGetBytesPerRow(source)
        let dstStride = CVPixelBufferGetBytesPerRow(destination)
        let rowBytes = min(srcStride, dstStride)
        for row in 0..<height {
            memcpy(dst.advanced(by: row * dstStride), src.advanced(by: row * srcStride), rowBytes)
        }
        return destination
    }

    func drawCursor(into buffer: CVPixelBuffer, at point: CGPoint, scale: CGFloat) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let bitmapInfo = CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        guard let ctx = CGContext(
            data: base,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: stride,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: bitmapInfo
        ) else { return }

        // CVPixelBuffers are top-down; flip the context so the path below uses
        // the same top-left origin as the synthetic cursor on the canvas.
        ctx.translateBy(x: 0, y: CGFloat(height))
        ctx.scaleBy(x: 1, y: -1)
        ctx.saveGState()
        ctx.translateBy(x: point.x, y: point.y)
        ctx.scaleBy(x: scale, y: scale)

        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 0, y: 20.5))
        path.addLine(to: CGPoint(x: 5.2, y: 15.9))
        path.addLine(to: CGPoint(x: 8.7, y: 23.5))
        path.addLine(to: CGPoint(x: 12.3, y: 21.8))
        path.addLine(to: CGPoint(x: 8.9, y: 14.4))
        path.addLine(to: CGPoint(x: 15.1, y: 14.4))
        path.closeSubpath()

        ctx.setShadow(offset: CGSize(width: 1, height: 1), blur: 2.5,
                      color: CGColor(red: 0, green: 0, blue: 0, alpha: 0.35))
        ctx.addPath(path)
        // Match the macOS pointer: black fill with a white outline.
        ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
        ctx.fillPath()

        ctx.setShadow(offset: .zero, blur: 0, color: nil)
        ctx.addPath(path)
        ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        ctx.setLineWidth(1.35)
        ctx.strokePath()
        ctx.restoreGState()
    }

    func makeSampleBuffer(from buffer: CVPixelBuffer, pts: CMTime, duration: CMTime) -> CMSampleBuffer? {
        var format: CMFormatDescription?
        guard CMVideoFormatDescriptionCreateForImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buffer,
            formatDescriptionOut: &format
        ) == noErr, let format else { return nil }
        var timing = CMSampleTimingInfo(duration: duration, presentationTimeStamp: pts, decodeTimeStamp: .invalid)
        var sample: CMSampleBuffer?
        guard CMSampleBufferCreateReadyWithImageBuffer(
            allocator: kCFAllocatorDefault,
            imageBuffer: buffer,
            formatDescription: format,
            sampleTiming: &timing,
            sampleBufferOut: &sample
        ) == noErr else { return nil }
        return sample
    }

    func startLargeCursorTimer() {
        guard args.cursor == "large", largeCursorTimer == nil else { return }
        let interval = 1.0 / Double(max(1, args.fps))
        let timer = DispatchSource.makeTimerSource(queue: videoQueue)
        timer.schedule(deadline: .now() + interval, repeating: interval, leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.appendLargeCursorFrame() }
        timer.resume()
        largeCursorTimer = timer
    }

    func appendLargeCursorFrame() {
        guard !stopped,
              let writer,
              writer.status == .writing,
              let videoInput,
              videoInput.isReadyForMoreMediaData,
              let latest = latestFrame,
              let startPTS = sessionStartPTS,
              let startHost = sessionStartHost else { return }

        let elapsed = CACurrentMediaTime() - startHost
        let pts = CMTimeAdd(startPTS, CMTime(seconds: elapsed, preferredTimescale: 1_000_000_000))
        guard let frame = copyPixelBuffer(latest) else { return }
        if let position = cursorPixelPosition() {
            drawCursor(into: frame, at: position, scale: pointPixelScale * 1.8)
        }
        guard let sample = makeSampleBuffer(from: frame, pts: pts, duration: CMTime(value: 1, timescale: args.fps)) else {
            return
        }
        if !videoInput.append(sample) {
            emit(["event": "error", "message": "append(video) failed: \(String(describing: writer.error?.localizedDescription))"])
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
                sessionStartHost = CACurrentMediaTime()
            }
            guard writer.status == .writing else { return }
            if args.cursor == "large" {
                sawVideo = true
                if let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
                    latestFrame = copyPixelBuffer(imageBuffer)
                }
                startLargeCursorTimer()
                return
            }
            if !sawVideo {
                sawVideo = true
            }
            if !videoInput.append(sampleBuffer) {
                emit(["event": "error", "message": "append(video) failed: \(String(describing: writer.error?.localizedDescription))"])
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
