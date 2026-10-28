package app

import (
	"runtime"
	"strings"
	"testing"

	"github.com/wailsapp/wails/v2/pkg/menu"
)

type menuProbe struct {
	actions    []string
	urls       []string
	fullscreen int
}

func (p *menuProbe) hooks() MenuHooks {
	return MenuHooks{
		Emit:             func(a string) { p.actions = append(p.actions, a) },
		OpenURL:          func(u string) { p.urls = append(p.urls, u) },
		ToggleFullScreen: func() { p.fullscreen++ },
	}
}

func submenu(m *menu.Menu, label string) *menu.MenuItem {
	for _, it := range m.Items {
		if it.Label == label && it.SubMenu != nil {
			return it
		}
	}
	return nil
}

func labels(it *menu.MenuItem) []string {
	var out []string
	for _, c := range it.SubMenu.Items {
		if c.IsSeparator() {
			out = append(out, "-")
		} else {
			out = append(out, c.Label)
		}
	}
	return out
}

func click(t *testing.T, it *menu.MenuItem) {
	t.Helper()
	if it.Click == nil {
		t.Fatalf("%q has no action", it.Label)
	}
	it.Click(&menu.CallbackData{MenuItem: it})
}

func find(it *menu.MenuItem, label string) *menu.MenuItem {
	for _, c := range it.SubMenu.Items {
		if c.Label == label {
			return c
		}
	}
	return nil
}

func TestMenuBarHasTheUsualMenus(t *testing.T) {
	m := BuildMenu((&menuProbe{}).hooks())
	var top []string
	for _, it := range m.Items {
		switch {
		case it.Role != 0 && it.Label == "":
			top = append(top, "role:"+string(rune('0'+int(it.Role)%10)))
		default:
			top = append(top, it.Label)
		}
	}
	if len(m.Items) != 6 {
		t.Fatalf("App, File, Edit, View, Window, Help: %v", top)
	}
	for _, name := range []string{"File", "View", "Help"} {
		if submenu(m, name) == nil {
			t.Errorf("no %s menu", name)
		}
	}
	if m.Items[0].Role != menu.AppMenuRole || m.Items[2].Role != menu.EditMenuRole || m.Items[4].Role != menu.WindowMenuRole {
		t.Fatal("the system's own App, Edit and Window menus are used, so copy, paste, hide and quit behave natively")
	}
}

func TestFileMenuAsksTheWindowForTheRightActions(t *testing.T) {
	p := &menuProbe{}
	file := submenu(BuildMenu(p.hooks()), "File")
	want := map[string]string{
		"New Host…": ActNewHost, "New Group…": ActNewGroup, "New Terminal": ActNewTerminal, "New Serial Connection…": ActSerial,
		"Import…": ActImport, "Settings…": ActSettings, "Duplicate Tab": ActDuplicateTab, "Close Tab": ActCloseTab,
		"Close Pane": ActClosePane, "Lock Vault": ActLock,
	}
	for label, action := range want {
		it := find(file, label)
		if it == nil {
			t.Fatalf("File has no %q: %v", label, labels(file))
		}
		p.actions = nil
		click(t, it)
		if len(p.actions) != 1 || p.actions[0] != action {
			t.Errorf("%s sent %v, want %s", label, p.actions, action)
		}
	}
	if acc := find(file, "Settings…").Accelerator; acc == nil || acc.Key != "," {
		t.Fatalf("Settings… is Cmd+, like every Mac app: %+v", acc)
	}
	for label, it := range map[string]*menu.MenuItem{"New Host…": find(file, "New Host…"), "Close Tab": find(file, "Close Tab"), "Lock Vault": find(file, "Lock Vault")} {
		if it.Accelerator != nil {
			t.Errorf("%s has a fixed key, but the keys are configurable in Settings and handled by the page", label)
		}
	}
}

func TestViewMenuZoomsSplitsAndShowsPages(t *testing.T) {
	p := &menuProbe{}
	view := submenu(BuildMenu(p.hooks()), "View")
	for _, c := range []struct{ label, action string }{
		{"Zoom In", ActZoomIn}, {"Zoom Out", ActZoomOut}, {"Actual Size", ActZoomReset}, {"Split Pane Right", ActSplitRight},
		{"Split Pane Down", ActSplitDown}, {"Broadcast Input", ActBroadcast}, {"Hosts", "page:hosts"}, {"Keychain", "page:keychain"},
		{"Port Forwarding", "page:forwards"}, {"Snippets", "page:snippets"}, {"SFTP", "page:sftp"}, {"Known Hosts", "page:knownhosts"}, {"Logs", "page:logs"},
	} {
		p.actions = nil
		click(t, find(view, c.label))
		if len(p.actions) != 1 || p.actions[0] != c.action {
			t.Errorf("%s sent %v, want %s", c.label, p.actions, c.action)
		}
	}
	fs := find(view, "Enter Full Screen")
	click(t, fs)
	if p.fullscreen != 1 {
		t.Fatal("full screen toggles through the window")
	}
	if fs.Accelerator == nil || fs.Accelerator.Key != "f" {
		t.Fatalf("%+v", fs.Accelerator)
	}
}

func TestHelpMenuOpensOnlyTheProjectPages(t *testing.T) {
	p := &menuProbe{}
	help := submenu(BuildMenu(p.hooks()), "Help")
	if len(help.SubMenu.Items) != len(HelpLinks) || len(HelpLinks) != 5 {
		t.Fatalf("%v", labels(help))
	}
	for i, l := range HelpLinks {
		click(t, help.SubMenu.Items[i])
		if p.urls[i] != l.URL || !urlAllowed(l.URL) {
			t.Errorf("%s: %q must be one of the allowed project links", l.Label, l.URL)
		}
	}
}

func TestEveryMenuActionIsKnownAndUnique(t *testing.T) {
	seen := map[string]bool{}
	for _, a := range MenuActions {
		if a == "" || seen[a] {
			t.Errorf("duplicate or empty action %q", a)
		}
		seen[a] = true
	}
	p := &menuProbe{}
	m := BuildMenu(p.hooks())
	for _, name := range []string{"File", "View"} {
		for _, it := range submenu(m, name).SubMenu.Items {
			if it.IsSeparator() || it.Label == "Enter Full Screen" {
				continue
			}
			p.actions = nil
			click(t, it)
			if len(p.actions) != 1 || !seen[p.actions[0]] {
				t.Errorf("%s → %v is not in MenuActions", it.Label, p.actions)
			}
		}
	}
	if !strings.HasPrefix(ActPagePrefix, "page") {
		t.Fatal("prefix")
	}
}

func TestAppMenuIsSafeBeforeTheWindowExists(t *testing.T) {
	a := &App{}
	m := a.Menu() // no context yet: clicking must do nothing, not crash
	for _, it := range submenu(m, "File").SubMenu.Items {
		if !it.IsSeparator() {
			click(t, it)
		}
	}
	click(t, find(submenu(m, "View"), "Enter Full Screen"))
	click(t, submenu(m, "Help").SubMenu.Items[0])
}

func TestAcceleratorFromShortcutText(t *testing.T) {
	cases := map[string]string{
		"Mod+Shift+T":    "t|cmdorctrl,shift",
		"Ctrl+Tab":       "tab|ctrl",
		"Ctrl+Shift+Tab": "tab|ctrl,shift",
		"Mod+,":          ",|cmdorctrl",
		"Mod+Alt+B":      "b|cmdorctrl,optionoralt",
		"Mod+ArrowUp":    "up|cmdorctrl",
	}
	for combo, want := range cases {
		a := Accelerator(combo)
		if a == nil {
			t.Fatalf("%s: no accelerator", combo)
		}
		var mods []string
		for _, m := range a.Modifiers {
			mods = append(mods, string(m))
		}
		if got := a.Key + "|" + strings.Join(mods, ","); got != want {
			t.Errorf("%s: got %q want %q", combo, got, want)
		}
	}
	if Accelerator("Hyper+X") != nil {
		t.Error("an unknown modifier has no menu form")
	}
}

func TestMenuShowsTheCurrentShortcutsOnMac(t *testing.T) {
	h := (&menuProbe{}).hooks()
	h.Shortcuts = map[string]string{"close_tab": "Mod+W", "open_sftp": "Mod+Shift+S", "go_hosts": "Alt+1", "next_tab": "Ctrl+Tab"}
	m := BuildMenu(h)
	closeTab := find(submenu(m, "File"), "Close Tab")
	sftp := find(submenu(m, "View"), "SFTP")
	if runtime.GOOS != "darwin" {
		if closeTab.Accelerator != nil || sftp.Accelerator != nil {
			t.Fatal("off macOS the page owns the keys: the menu shows none")
		}
		return
	}
	if closeTab.Accelerator == nil || closeTab.Accelerator.Key != "w" {
		t.Fatalf("Close Tab: %+v", closeTab.Accelerator)
	}
	if sftp.Accelerator == nil || sftp.Accelerator.Key != "s" || len(sftp.Accelerator.Modifiers) != 2 {
		t.Fatalf("SFTP: %+v", sftp.Accelerator)
	}
	if hosts := find(submenu(m, "View"), "Hosts"); hosts.Accelerator == nil || hosts.Accelerator.Key != "1" {
		t.Fatalf("a changed key shows: %+v", hosts.Accelerator)
	}
	if next := find(submenu(m, "File"), "Next Tab"); next.Accelerator == nil || next.Accelerator.Key != "tab" {
		t.Fatalf("Next Tab: %+v", next.Accelerator)
	}
	if find(submenu(m, "File"), "New Group…").Accelerator != nil {
		t.Fatal("an item with no shortcut shows none")
	}
}

func TestATwoStepShortcutHasNoMenuKey(t *testing.T) {
	if Accelerator("Mod+K M") != nil {
		t.Error("a two-step shortcut cannot be a menu key")
	}
}
