package app

import (
	"github.com/wailsapp/wails/v2/pkg/menu"
	"github.com/wailsapp/wails/v2/pkg/menu/keys"
)

// MenuEvent is the Wails event the menu bar sends to the main window; its payload is the action name.
const MenuEvent = "menu:action"

// Actions the menu can ask for. The frontend (App.tsx) handles exactly these.
const (
	ActNewHost      = "new_host"
	ActNewGroup     = "new_group"
	ActNewTerminal  = "new_terminal"
	ActSerial       = "serial"
	ActImport       = "import"
	ActSettings     = "open_settings"
	ActCloseTab     = "close_tab"
	ActClosePane    = "close_pane"
	ActLock         = "lock_vault"
	ActZoomIn       = "zoom_in"
	ActZoomOut      = "zoom_out"
	ActZoomReset    = "zoom_reset"
	ActPagePrefix   = "page:"
	ActBroadcast    = "broadcast_input"
	ActSplitRight   = "split_right"
	ActSplitDown    = "split_down"
	ActDuplicateTab = "duplicate_tab"
)

// MenuActions lists every action name, for tests and for the frontend to stay in step.
var MenuActions = []string{
	ActNewHost, ActNewGroup, ActNewTerminal, ActSerial, ActImport, ActSettings, ActCloseTab, ActClosePane, ActLock,
	ActZoomIn, ActZoomOut, ActZoomReset, ActBroadcast, ActSplitRight, ActSplitDown, ActDuplicateTab,
	ActPagePrefix + "hosts", ActPagePrefix + "keychain", ActPagePrefix + "forwards", ActPagePrefix + "snippets",
	ActPagePrefix + "sftp", ActPagePrefix + "knownhosts", ActPagePrefix + "logs",
}

// HelpLinks are the Help menu entries: the project's own pages only (see urlAllowed).
var HelpLinks = []struct{ Label, URL string }{
	{"Documentation", "https://github.com/vunguyenvu35/vvterm#readme"},
	{"Request a Feature", "https://github.com/vunguyenvu35/vvterm/issues/new"},
	{"Report a Bug", "https://github.com/vunguyenvu35/vvterm/issues/new"},
	{"Release Notes", "https://github.com/vunguyenvu35/vvterm/blob/main/RELEASE_NOTES.md"},
	{"Support on Ko-fi", "https://ko-fi.com/vunguyenvu"},
}

// MenuHooks is what the menu needs from the running app.
type MenuHooks struct {
	Emit             func(action string)
	OpenURL          func(url string)
	ToggleFullScreen func()
}

// BuildMenu makes the application menu bar: the system's own App, Edit and Window menus, and File, View and
// Help with VVTerm's actions. Items carry no key hints of their own (the keys are configurable in Settings
// and are handled by the page), except the standard Settings and Full Screen ones.
func BuildMenu(h MenuHooks) *menu.Menu {
	act := func(label, action string, acc *keys.Accelerator) *menu.MenuItem {
		return menu.Text(label, acc, func(*menu.CallbackData) { h.Emit(action) })
	}
	file := menu.NewMenu()
	file.Append(act("New Host…", ActNewHost, nil))
	file.Append(act("New Group…", ActNewGroup, nil))
	file.Append(act("New Terminal", ActNewTerminal, nil))
	file.Append(act("New Serial Connection…", ActSerial, nil))
	file.Append(menu.Separator())
	file.Append(act("Import…", ActImport, nil))
	file.Append(menu.Separator())
	file.Append(act("Settings…", ActSettings, keys.CmdOrCtrl(",")))
	file.Append(menu.Separator())
	file.Append(act("Duplicate Tab", ActDuplicateTab, nil))
	file.Append(act("Close Tab", ActCloseTab, nil))
	file.Append(act("Close Pane", ActClosePane, nil))
	file.Append(menu.Separator())
	file.Append(act("Lock Vault", ActLock, nil))

	view := menu.NewMenu()
	view.Append(act("Zoom In", ActZoomIn, nil))
	view.Append(act("Zoom Out", ActZoomOut, nil))
	view.Append(act("Actual Size", ActZoomReset, nil))
	view.Append(menu.Separator())
	view.Append(act("Split Pane Right", ActSplitRight, nil))
	view.Append(act("Split Pane Down", ActSplitDown, nil))
	view.Append(act("Broadcast Input", ActBroadcast, nil))
	view.Append(menu.Separator())
	for _, p := range []struct{ label, id string }{
		{"Hosts", "hosts"}, {"Keychain", "keychain"}, {"Port Forwarding", "forwards"}, {"Snippets", "snippets"},
		{"SFTP", "sftp"}, {"Known Hosts", "knownhosts"}, {"Logs", "logs"},
	} {
		view.Append(act(p.label, ActPagePrefix+p.id, nil))
	}
	view.Append(menu.Separator())
	view.Append(menu.Text("Enter Full Screen", keys.Combo("f", keys.ControlKey, keys.CmdOrCtrlKey), func(*menu.CallbackData) { h.ToggleFullScreen() }))

	help := menu.NewMenu()
	for _, l := range HelpLinks {
		url := l.URL
		help.Append(menu.Text(l.Label, nil, func(*menu.CallbackData) { h.OpenURL(url) }))
	}

	return menu.NewMenuFromItems(
		menu.AppMenu(),
		menu.SubMenu("File", file),
		menu.EditMenu(),
		menu.SubMenu("View", view),
		menu.WindowMenu(),
		menu.SubMenu("Help", help),
	)
}
