// Configure only an ephemeral GitHub macOS runner; never change a local display.
import Foundation
import CoreGraphics

guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" else {
    fputs("Display configuration is restricted to GitHub Actions.\n", stderr)
    exit(2)
}
let display = CGMainDisplayID()
let before = CGDisplayBounds(display)
let modes = CGDisplayCopyAllDisplayModes(display, nil) as? [CGDisplayMode] ?? []
let candidates = modes.filter { $0.width >= 1440 && $0.height >= 1000 }
    .sorted { $0.width * $0.height < $1.width * $1.height }
let verifyOnly = CommandLine.arguments.contains("--verify-only")
var errorCode: Int32 = 0
if !verifyOnly && (before.width < 1440 || before.height < 1000) {
    if let selected = candidates.first {
        // CGDisplaySetDisplayMode reverts when this process exits. Commit for
        // the ephemeral runner's login session, then verify in a new process.
        var config: CGDisplayConfigRef?
        errorCode = CGBeginDisplayConfiguration(&config).rawValue
        if errorCode == 0, let transaction = config {
            errorCode = CGConfigureDisplayWithDisplayMode(transaction, display, selected, nil).rawValue
            if errorCode == 0 {
                errorCode = CGCompleteDisplayConfiguration(transaction, .forSession).rawValue
            } else {
                CGCancelDisplayConfiguration(transaction)
            }
        }
    } else {
        errorCode = -1
    }
}
let after = CGDisplayBounds(display)
let report: [String: Any] = [
    "before": ["width": before.width, "height": before.height],
    "after": ["width": after.width, "height": after.height],
    "verifyOnly": verifyOnly,
    "errorCode": errorCode,
    "availableModes": modes.map { ["width": $0.width, "height": $0.height] }
]
let bytes = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
print(String(data: bytes, encoding: .utf8)!)
guard errorCode == 0, after.width >= 1440, after.height >= 1000 else { exit(1) }
