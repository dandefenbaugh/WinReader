# WinReader

A desktop RSS, Atom, and JSON Feed reader with an original interface inspired by Windows 3.1. It starts with the eight subscriptions in the supplied OPML.

## Run on macOS

With Node.js 22 or newer installed, run the following in the project folder:

```sh
npm ci
npm start
```

Choose a subscription in the left column, then select a headline in the middle
column to read it on the right. The count next to each subscription shows its
unread headlines. Use **Mark Subscription as Read** or **Mark All Subscriptions as Read**
on the toolbar or in the **Feed** menu to clear the current unread items.
The article pane displays formatting and images supplied by the feed.
Use **Edit → Undo Mark as Read** or **Ctrl+Z** to reverse the most recent bulk
read action. Right-click a subscription for its commands. **View** lets you
show or hide the toolbar and status bar. **View → Appearance** offers Windows
3.1, Windows XP (Luna Blue), and DOS Commander, and remembers your selection.
Change the article text under **View → Article Font Size…** in Windows 3.1 and
DOS Commander or **View → Text Size** in Windows XP. All three themes share
the saved text size. **Open Article** opens the source in your default browser. WinReader refreshes at startup and on demand, and remembers which headlines you have read.

Use **Subscriptions…** on the toolbar or under **File** to add, edit, or delete
feed URLs. Click **OK** in the Subscriptions dialog to save your changes.

- Drag the dividers between columns to resize the panes. You can also tab to a
  divider and use the Left and Right arrow keys. WinReader remembers the widths.
- **F5** refreshes all feeds. WinReader opens with the last saved headlines and
  checks for updates in the background. A **!** marks a failed refresh. Hover over
  a subscription to see its last successful check.
- **Alt** focuses the menu bar. **Alt+F**, **Alt+E**, **Alt+V**, **Alt+D**, and **Alt+H** open File, Edit, View, Feed, and Help.
- Use the arrow keys to navigate lists and menus and **Esc** to close a menu.
- Use the upper-left window menu to close, minimize, or maximize WinReader.

## Standalone macOS app

Double-click `WinReader.app` in Finder. You can move it to Applications and pin
its Dock icon via **Options → Keep in Dock**. The app includes its own runtime.

To rebuild the locally signed app, run `npm run package:mac` on macOS. The app
lands in the `release` folder. The build targets the current Mac's architecture
by default.
