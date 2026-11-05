import Foundation
import Darwin

// Read-only process identity. Never reads argv, environment, files or sockets.
func cString<T>(_ value: inout T) -> String {
    withUnsafeBytes(of: &value) { bytes in
        let prefix = bytes.prefix { $0 != 0 }
        return String(decoding: prefix, as: UTF8.self)
    }
}
let input = FileHandle.standardInput.readDataToEndOfFile()
guard input.count <= 16384,
      let pids = try? JSONSerialization.jsonObject(with: input) as? [Int],
      pids.count <= 256,
      pids.allSatisfy({ $0 > 1 && $0 <= Int(Int32.max) }) else { exit(2) }
var rows: [[String: Any]] = []
for rawPID in Set(pids).sorted() {
    let pid = pid_t(rawPID)
    var info = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size,
          info.pbi_uid == getuid(), info.pbi_ruid == getuid() else { continue }
    var vnode = proc_vnodepathinfo()
    let vnodeSize = Int32(MemoryLayout<proc_vnodepathinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0, &vnode, vnodeSize) == vnodeSize else { continue }
    var executable = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &executable, UInt32(executable.count)) > 0 else { continue }
    let cwd = cString(&vnode.pvi_cdir.vip_path)
    guard cwd.hasPrefix("/") else { continue }
    rows.append([
        "pid": rawPID, "ppid": Int(info.pbi_ppid), "uid": Int(info.pbi_uid),
        "started": "\(info.pbi_start_tvsec):\(info.pbi_start_tvusec)",
        "executable": String(cString: executable), "cwd": cwd,
        "zombie": info.pbi_status == 5
    ])
}
guard let output = try? JSONSerialization.data(withJSONObject: rows, options: [.sortedKeys]) else { exit(3) }
FileHandle.standardOutput.write(output)
FileHandle.standardOutput.write(Data([10]))
