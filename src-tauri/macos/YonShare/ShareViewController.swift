// Yon Share extension: Finder/any app "Share → Yon".
// It has no UI of its own. It collects the shared file URLs and passes them
// as CLI arguments to the containing Yon.app, where Yon shows its device picker.
// Nothing is sent from here.

import Cocoa
import UniformTypeIdentifiers

final class ShareViewController: NSViewController {
    override func loadView() {
        view = NSView(frame: .zero)
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        let providers = items.flatMap { $0.attachments ?? [] }
            .filter { $0.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) }

        let group = DispatchGroup()
        let lock = NSLock()
        var urls: [URL] = []
        for provider in providers {
            group.enter()
            _ = provider.loadObject(ofClass: URL.self) { url, _ in
                if let url, url.isFileURL {
                    lock.lock()
                    urls.append(url)
                    lock.unlock()
                }
                group.leave()
            }
        }
        group.notify(queue: .main) { [weak self] in self?.handOff(urls) }
    }

    private func handOff(_ urls: [URL]) {
        guard !urls.isEmpty, let app = containingApp() else { return finish() }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        config.createsNewApplicationInstance = true
        config.arguments = urls.map(\.path)
        // WHY: macOS refuses to open a Windows .exe as a document with any app
        // ("incorrect executable format"). As arguments the paths always get
        // through: the new Yon hands them to the running one (single-instance)
        // or, if Yon wasn't running, reads them at startup.
        NSWorkspace.shared.openApplication(at: app, configuration: config) { _, error in
            guard let error else { return DispatchQueue.main.async { self.finish() } }
            NSLog("YonShare: could not pass files as arguments: \(error.localizedDescription)")
            self.openAsDocuments(urls, with: app)
        }
    }

    /// The pre-0.2.3 hand-off (like "Open With → Yon"), kept as a fallback.
    private func openAsDocuments(_ urls: [URL], with app: URL) {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open(urls, withApplicationAt: app, configuration: config) { _, error in
            if let error { NSLog("YonShare: could not open Yon: \(error.localizedDescription)") }
            DispatchQueue.main.async { self.finish() }
        }
    }

    /// Yon.app/Contents/PlugIns/YonShare.appex → Yon.app
    private func containingApp() -> URL? {
        let app = Bundle.main.bundleURL
            .deletingLastPathComponent()  // PlugIns
            .deletingLastPathComponent()  // Contents
            .deletingLastPathComponent()  // Yon.app
        return app.pathExtension == "app" ? app : nil
    }

    private func finish() {
        extensionContext?.completeRequest(returningItems: nil)
    }
}
