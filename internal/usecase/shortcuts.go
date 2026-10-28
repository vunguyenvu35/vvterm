package usecase

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	actionID  = regexp.MustCompile("^[a-z][a-z0-9_]{0,31}$")
	plainKey  = regexp.MustCompile("^[A-Za-z0-9,./;'\\[\\]\\\\\\-=`]$")
	fKey      = regexp.MustCompile("^F([1-9]|1[0-2])$")
	namedKeys = map[string]bool{"Tab": true, "Enter": true, "Space": true, "Backspace": true, "Delete": true, "ArrowUp": true,
		"ArrowDown": true, "ArrowLeft": true, "ArrowRight": true, "Home": true, "End": true, "PageUp": true, "PageDown": true}
	modifiers = map[string]bool{"Mod": true, "Ctrl": true, "Alt": true, "Shift": true, "Meta": true}
)

// maxShortcuts bounds the overrides stored in settings.json.
const maxShortcuts = 40

// ValidateCombo checks the textual form of a shortcut. A shortcut is one step ("Mod+K") or two steps separated by a
// space ("Mod+K M": press Cmd+K, let go, press M). A step is modifiers (Mod = Cmd on macOS, Ctrl elsewhere; Ctrl, Alt,
// Shift, Meta) joined by "+" and ending with one key. Escape is reserved (it always closes panels). The first step,
// like a single-step shortcut, needs at least one of Mod, Ctrl, Alt or Meta (F-keys excepted) so ordinary typing can
// never trigger a shortcut; the second step of a chord may be a bare key.
func ValidateCombo(c string) error {
	steps := strings.Split(c, " ")
	if len(steps) > 2 {
		return fmt.Errorf("%q has more than two steps", c)
	}
	for i, step := range steps {
		if err := validateStep(step, i == 0); err != nil {
			return err
		}
	}
	return nil
}

func validateStep(c string, needsModifier bool) error {
	parts := strings.Split(c, "+")
	key := parts[len(parts)-1]
	mods := map[string]bool{}
	for _, m := range parts[:len(parts)-1] {
		if !modifiers[m] || mods[m] {
			return fmt.Errorf("invalid modifier %q in %q", m, c)
		}
		mods[m] = true
	}
	switch {
	case key == "Escape":
		return fmt.Errorf("Escape is reserved")
	case fKey.MatchString(key):
		return nil
	case namedKeys[key], plainKey.MatchString(key):
	default:
		return fmt.Errorf("invalid key %q in %q", key, c)
	}
	if needsModifier && !mods["Mod"] && !mods["Ctrl"] && !mods["Alt"] && !mods["Meta"] {
		return fmt.Errorf("%q needs Mod, Ctrl, Alt or Meta", c)
	}
	return nil
}

// ValidateShortcuts checks the user's overrides: id shape, valid combos, and no two actions sharing
// the same combination.
func ValidateShortcuts(m map[string]string) error {
	if len(m) > maxShortcuts {
		return fmt.Errorf("too many shortcuts (max %d)", maxShortcuts)
	}
	ids := make([]string, 0, len(m))
	for id := range m {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	seen := map[string]string{}   // whole shortcut -> action
	starts := map[string]string{} // first step of a two-step shortcut -> action
	for _, id := range ids {
		if !actionID.MatchString(id) {
			return fmt.Errorf("invalid action id %q", id)
		}
		if err := ValidateCombo(m[id]); err != nil {
			return fmt.Errorf("%s: %w", id, err)
		}
		norm := strings.ToLower(m[id])
		if other, dup := seen[norm]; dup {
			return fmt.Errorf("%s and %s share the shortcut %s", other, id, m[id])
		}
		seen[norm] = id
		if first, _, chord := strings.Cut(norm, " "); chord {
			starts[first] = id
		}
	}
	// a shortcut that is the first step of a two-step one: the two-step one could never be reached
	for _, id := range ids {
		norm := strings.ToLower(m[id])
		if !strings.Contains(norm, " ") {
			if other, clash := starts[norm]; clash {
				return fmt.Errorf("%s uses %s, which %s needs as the first step of its shortcut", id, m[id], other)
			}
		}
	}
	return nil
}
