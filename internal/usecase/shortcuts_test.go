package usecase

import (
	"strings"
	"testing"
)

func TestValidateCombo(t *testing.T) {
	good := []string{"Mod+,", "Mod+F", "Mod+Shift+K", "Ctrl+Alt+Delete", "Alt+ArrowLeft", "Mod+Tab", "Ctrl+Shift+Tab", "F5", "Shift+F12", "Meta+/", "Mod+`", "Mod+1", "Mod+Space", "Mod+["}
	for _, c := range good {
		if err := ValidateCombo(c); err != nil {
			t.Errorf("%q rejected: %v", c, err)
		}
	}
	bad := map[string]string{
		"":             "empty",
		"K":            "plain letter would trigger while typing",
		"Shift+K":      "shift alone is not enough",
		"Enter":        "plain key",
		"Mod+Escape":   "Escape is reserved",
		"Escape":       "Escape is reserved",
		"Mod+Mod+K":    "duplicate modifier",
		"Hyper+K":      "unknown modifier",
		"Mod+":         "missing key",
		"Mod+KK":       "two characters",
		"Mod+F13":      "F13 does not exist",
		"mod+k":        "modifiers are case sensitive",
		"Mod+Shift":    "a modifier is not a key",
		"Mod+\n":       "control character",
		"Mod+<script>": "garbage",
		"Mod + K":      "spaces",
	}
	for c, why := range bad {
		if err := ValidateCombo(c); err == nil {
			t.Errorf("%q accepted (%s)", c, why)
		}
	}
}

func TestValidateShortcuts(t *testing.T) {
	if err := ValidateShortcuts(nil); err != nil {
		t.Fatal(err)
	}
	if err := ValidateShortcuts(map[string]string{"open_settings": "Mod+,", "new_connection": "Mod+T"}); err != nil {
		t.Fatal(err)
	}
	cases := map[string]map[string]string{
		"duplicate combo":                    {"a": "Mod+K", "b": "mod+k"[:0] + "Mod+K"},
		"duplicate ignoring case of the key": {"a": "Mod+k", "b": "Mod+K"},
		"bad id":                             {"Open Settings": "Mod+,"},
		"id too long":                        {strings.Repeat("a", 33): "Mod+,"},
		"bad combo":                          {"a": "K"},
	}
	for name, m := range cases {
		if err := ValidateShortcuts(m); err == nil {
			t.Errorf("%s accepted", name)
		}
	}
	many := map[string]string{}
	for i := 0; i < 41; i++ {
		many["act"+strings.Repeat("x", i%5)+string(rune('a'+i%26))+string(rune('a'+i/26))] = "Mod+" + string(rune('a'+i%26))
	}
	if err := ValidateShortcuts(many); err == nil {
		t.Error("more than 40 overrides accepted")
	}
}
