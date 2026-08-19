// Bun on Windows can miss Chrome's final child-process close notification:
// Chrome is already gone, but Puppeteer's browser.close() promise never
// resolves. Stop the exact launched browser tree on Windows and disconnect
// Puppeteer's transport. Other platforms use the normal graceful close.
export async function closeBrowser(browser: {
  close(): Promise<void>;
  disconnect(): void;
  process(): { pid?: number; kill(): boolean } | null;
}): Promise<void> {
  const child = browser.process();
  const pid = child?.pid;
  if (process.platform === "win32" && pid) {
    browser.disconnect();
    child.kill();
    Bun.spawnSync(["taskkill", "/pid", String(pid), "/t", "/f"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  await browser.close();
}
