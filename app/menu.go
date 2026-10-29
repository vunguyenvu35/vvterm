package app

import (
	"runtime"
	"strings"

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
	ActNewTab       = "new_connection"
	ActNextTab      = "next_tab"
	ActPrevTab      = "prev_tab"
	ActVaults       = "go_vaults"
	ActAbout        = "about"
	ActCheckUpdate  = "check_update"
)

// MenuActions lists every action name, for tests and for the frontend to stay in step.
var MenuActions = []string{
	ActNewHost, ActNewGroup, ActNewTerminal, ActSerial, ActImport, ActSettings, ActCloseTab, ActClosePane, ActLock,
	ActZoomIn, ActZoomOut, ActZoomReset, ActBroadcast, ActSplitRight, ActSplitDown, ActDuplicateTab,
	ActNewTab, ActNextTab, ActPrevTab, ActVaults, ActAbout, ActCheckUpdate,
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

// menuShortcut is the shortcut (the id used in Settings → Shortcuts) that does the same as a menu action, so the
// menu can show its keys.
var menuShortcut = map[string]string{
	ActNewTerminal: "new_local_terminal", ActNewHost: "new_host", ActSettings: "open_settings", ActNewTab: "new_connection",
	ActCloseTab: "close_tab", ActClosePane: "close_pane", ActLock: "lock_vault", ActNextTab: "next_tab", ActPrevTab: "prev_tab",
	ActZoomIn: "zoom_in", ActZoomOut: "zoom_out", ActZoomReset: "zoom_reset", ActSplitRight: "split_right", ActSplitDown: "split_down",
	ActBroadcast: "broadcast_input", ActDuplicateTab: "duplicate_tab", ActVaults: "go_vaults",
	ActPagePrefix + "hosts": "go_hosts", ActPagePrefix + "keychain": "go_keychain", ActPagePrefix + "forwards": "go_forwards",
	ActPagePrefix + "snippets": "go_snippets", ActPagePrefix + "sftp": "open_sftp", ActPagePrefix + "knownhosts": "go_knownhosts",
	ActPagePrefix + "logs": "go_logs",
}

var namedAccelKeys = map[string]string{"Tab": "tab", "Enter": "enter", "Space": "space", "Backspace": "backspace", "Delete": "delete",
	"ArrowUp": "up", "ArrowDown": "down", "ArrowLeft": "left", "ArrowRight": "right", "Home": "home", "End": "end",
	"PageUp": "page up", "PageDown": "page down"}

// Accelerator turns a shortcut as written in Settings ("Mod+Shift+T") into the menu's key hint; nil when it has
// no menu form. Mod and Meta are Cmd.
func Accelerator(combo string) *keys.Accelerator {
	if strings.Contains(combo, " ") {
		return nil // a two-step shortcut has no key hint in the menu
	}
	parts := strings.Split(combo, "+")
	key := parts[len(parts)-1]
	if named, ok := namedAccelKeys[key]; ok {
		key = named
	} else {
		key = strings.ToLower(key)
	}
	if key == "" {
		return nil
	}
	acc := &keys.Accelerator{Key: key}
	for _, m := range parts[:len(parts)-1] {
		switch m {
		case "Mod", "Meta":
			acc.Modifiers = append(acc.Modifiers, keys.CmdOrCtrlKey)
		case "Ctrl":
			acc.Modifiers = append(acc.Modifiers, keys.ControlKey)
		case "Alt":
			acc.Modifiers = append(acc.Modifiers, keys.OptionOrAltKey)
		case "Shift":
			acc.Modifiers = append(acc.Modifiers, keys.ShiftKey)
		default:
			return nil
		}
	}
	return acc
}

// MenuHooks is what the menu needs from the running app.
type MenuHooks struct {
	// Shortcuts are the effective keys by shortcut id (from the page). On macOS the menu shows them and the menu
	// takes the key; elsewhere the page handles the keys itself, because Ctrl combinations belong to the terminal.
	Shortcuts        map[string]string
	Emit             func(action string)
	OpenURL          func(url string)
	ToggleFullScreen func()
}

// BuildMenu makes the application menu bar: the system's own App, Edit and Window menus, and File, View and
// Help with VVTerm's actions. On macOS an item shows its shortcut (the keys are configurable in Settings, so
// the page passes the current ones in h.Shortcuts); the Settings and Full Screen items always have theirs.
func BuildMenu(h MenuHooks) *menu.Menu {
	act := func(label, action string, acc *keys.Accelerator) *menu.MenuItem {
		if id, ok := menuShortcut[action]; ok && runtime.GOOS == "darwin" {
			if c := h.Shortcuts[id]; c != "" {
				acc = Accelerator(c)
			}
		}
		return menu.Text(label, acc, func(*menu.CallbackData) { h.Emit(action) })
	}
	file := menu.NewMenu()
	file.Append(act("New Connection…", ActNewTab, nil))
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
	file.Append(act("Next Tab", ActNextTab, nil))
	file.Append(act("Previous Tab", ActPrevTab, nil))
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
	view.Append(act("Back to Vaults", ActVaults, nil))
	for _, p := range []struct{ label, id string }{
		{"Hosts", "hosts"}, {"Keychain", "keychain"}, {"Port Forwarding", "forwards"}, {"Snippets", "snippets"},
		{"SFTP", "sftp"}, {"Known Hosts", "knownhosts"}, {"Logs", "logs"},
	} {
		view.Append(act(p.label, ActPagePrefix+p.id, nil))
	}
	view.Append(menu.Separator())
	view.Append(menu.Text("Enter Full Screen", keys.Combo("f", keys.ControlKey, keys.CmdOrCtrlKey), func(*menu.CallbackData) { h.ToggleFullScreen() }))

	help := menu.NewMenu()
	help.Append(act("About VVTerm", ActAbout, nil))
	help.Append(act("Check for Updates…", ActCheckUpdate, nil))
	help.Append(menu.Separator())
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
