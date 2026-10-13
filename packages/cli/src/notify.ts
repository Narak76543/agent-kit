/**
 * Desktop notifications for watch mode (Windows toast, macOS Notification Center, Linux notify-send).
 * The text never goes into a command line: Windows reads it from environment variables in a fixed PowerShell
 * script, macOS and Linux get it as separate arguments. A notification that cannot be shown is ignored.
 */
import type { Exec } from './exec.js';

const WINDOWS_TOAST = [
  "$ErrorActionPreference = 'Stop'",
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  "$x = $t.GetElementsByTagName('text')",
  '$x.Item(0).AppendChild($t.CreateTextNode($env:TOSSANA_NOTIFY_TITLE)) > $null',
  '$x.Item(1).AppendChild($t.CreateTextNode($env:TOSSANA_NOTIFY_TEXT)) > $null',
  "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))',
].join('; ');

export function notify(exec: Exec, platform: NodeJS.Platform, title: string, text: string): boolean {
  const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 250);
  const [t, m] = [oneLine(title), oneLine(text)];
  const run =
    platform === 'win32'
      ? exec('powershell', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_TOAST], {
          timeoutMs: 15_000,
          env: { TOSSANA_NOTIFY_TITLE: t, TOSSANA_NOTIFY_TEXT: m },
        })
      : platform === 'darwin'
        ? exec(
            'osascript',
            [
              '-e',
              'on run argv',
              '-e',
              'display notification (item 2 of argv) with title (item 1 of argv)',
              '-e',
              'end run',
              t,
              m,
            ],
            { timeoutMs: 15_000 },
          )
        : exec('notify-send', [t, m], { timeoutMs: 15_000 });
  return run.code === 0;
}
