package assistant

import "strings"

// ScreenText turns raw terminal output into the text a person would have seen: control sequences removed,
// carriage returns and backspaces applied, only the last n lines kept. alt reports that a full-screen
// program (vim, htop) was active at the end, whose output is not a readable log.
func ScreenText(raw []byte, n int) (text string, alt bool) {
	var lines [][]rune
	cur := []rune{}
	col := 0
	flush := func() { lines = append(lines, cur); cur = []rune{}; col = 0 }
	put := func(r rune) {
		if col < len(cur) {
			cur[col] = r
		} else {
			cur = append(cur, r)
		}
		col++
	}
	s := string(raw)
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		switch {
		case r == 0x1b:
			i++
			if i >= len(rs) {
				break
			}
			switch rs[i] {
			case '[': // CSI: parameters, then a final byte 0x40-0x7e
				j := i + 1
				for j < len(rs) && (rs[j] < 0x40 || rs[j] > 0x7e) {
					j++
				}
				if j < len(rs) {
					params := string(rs[i+1 : j])
					if rs[j] == 'h' || rs[j] == 'l' {
						if strings.HasPrefix(params, "?1049") || params == "?47" || params == "?1047" {
							alt = rs[j] == 'h'
						}
					}
				}
				i = j
			case ']': // OSC: until BEL or ESC \
				j := i + 1
				for j < len(rs) && rs[j] != 0x07 && !(rs[j] == 0x1b && j+1 < len(rs) && rs[j+1] == '\\') {
					j++
				}
				if j < len(rs) && rs[j] == 0x1b {
					j++
				}
				i = j
			default: // two-byte escape
			}
		case r == '\n':
			flush()
		case r == '\r':
			col = 0
		case r == '\b' || r == 0x7f:
			if col > 0 {
				col--
			}
		case r == '\t':
			put('\t')
		case r < 0x20:
		default:
			put(r)
		}
	}
	lines = append(lines, cur)
	for len(lines) > 0 && len(lines[len(lines)-1]) == 0 {
		lines = lines[:len(lines)-1]
	}
	if n > 0 && len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	var b strings.Builder
	for i, l := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString(strings.TrimRight(string(l), " \t"))
	}
	return b.String(), alt
}
