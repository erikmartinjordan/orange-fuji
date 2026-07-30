const fs = require("fs");
const path = require("path");
const yaml = require("../node_modules/js-yaml");

const rootDir = path.resolve(__dirname, "..");
const mainYmlPath = path.join(rootDir, "dist", "latest-mac.yml");
const legacyYmlPath = path.join(rootDir, "dist", "legacy", "latest-mac.yml");

let merged;
if (fs.existsSync(mainYmlPath)) {
  merged = yaml.load(fs.readFileSync(mainYmlPath, "utf8"));
} else {
  console.error("[merge-update-metadata] main latest-mac.yml not found");
  process.exit(1);
}

if (fs.existsSync(legacyYmlPath)) {
  const legacy = yaml.load(fs.readFileSync(legacyYmlPath, "utf8"));
  if (legacy.files && Array.isArray(legacy.files)) {
    const existingUrls = new Set((merged.files || []).map(f => f.url));
    for (const file of legacy.files) {
      if (!existingUrls.has(file.url)) {
        merged.files = merged.files || [];
        merged.files.push(file);
        existingUrls.add(file.url);
      }
    }
  }
}

fs.writeFileSync(mainYmlPath, yaml.dump(merged));
console.log("[merge-update-metadata] merged latest-mac.yml with legacy artifacts");
