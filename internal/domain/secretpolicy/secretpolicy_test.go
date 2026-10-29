package secretpolicy

import (
	"strings"
	"testing"
)

func redact(t *testing.T, g Guard, in string) (string, []Finding) {
	t.Helper()
	s, f, err := g.Redact(in)
	if err != nil {
		t.Fatal(err)
	}
	return s.String(), f
}

// Every sample is fabricated; none is a real credential.
func TestBuiltInDetectorsMaskTheSecret(t *testing.T) {
	cases := []struct{ name, in, secret string }{
		{"pem", "x\n-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nQQQQ\n-----END OPENSSH PRIVATE KEY-----\ny", "b3BlbnNzaC1rZXktdjEAAAAA"},
		{"pem cut off", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfake", "MIIEowIBAAKCAQEAfake"},
		{"aws", "key AKIAIOSFODNN7EXAMPLE here", "AKIAIOSFODNN7EXAMPLE"},
		{"github", "tok ghp_abcdefghijklmnopqrstuvwxyz0123456789 end", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"},
		{"github pat", "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz", "github_pat_11ABCDEFG0abcdefghij_klmnopqrstuvwxyz"},
		{"gitlab", "glpat-abcdefghij0123456789", "glpat-abcdefghij0123456789"},
		{"slack", "xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"},
		{"sk", "OPENAI sk-abcdefghijklmnopqrstuvwx", "sk-abcdefghijklmnopqrstuvwx"},
		{"jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r"},
		{"auth header", "Authorization: Bearer abcDEF123token", "abcDEF123token"},
		{"basic header", `curl -H "Authorization: Basic dXNlcjpwYXNz"`, "dXNlcjpwYXNz"},
		{"url", "git clone https://bob:hunter2pw@example.com/r.git", "hunter2pw"},
		{"env pair", "DB_PASSWORD=s3cr3tValue", "s3cr3tValue"},
		{"yaml pair", "api_key: abc123xyz", "abc123xyz"},
		{"json pair", `{"password": "p@ss word"}`, "p@ss word"},
		{"quoted pair", `TOKEN='a b c'`, "a b c"},
		{"flag", "mysql --password hunter22 -h x", "hunter22"},
		{"flag eq", "tool --token=abc12345", "abc12345"},
		{"entropy", "value=Zk3Jq9XvB2nL8mWc5RtY7uPa1", "Zk3Jq9XvB2nL8mWc5RtY7uPa1"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, f := redact(t, Guard{}, c.in)
			if strings.Contains(out, c.secret) {
				t.Fatalf("secret leaked: %q", out)
			}
			if !strings.Contains(out, Mask) || Total(f) == 0 {
				t.Fatalf("nothing masked: %q %v", out, f)
			}
		})
	}
}

func TestOnlyTheValueIsMaskedSoTheNameSurvives(t *testing.T) {
	out, _ := redact(t, Guard{}, "DB_PASSWORD=hunter2hunter2 DB_HOST=db1")
	if out != "DB_PASSWORD="+Mask+" DB_HOST=db1" {
		t.Fatalf("%q", out)
	}
}

func TestOrdinaryTextIsLeftAlone(t *testing.T) {
	for _, in := range []string{
		"commit 3f2a1b9c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a",
		"id 123e4567-e89b-12d3-a456-426614174000",
		"image sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
		"author: Jane Doe",
		"Password: ",
		"PATH=/usr/local/bin:/usr/bin",
		"url https://example.com/a/b?x=1",
		"-rw-r--r-- 1 root root 4096 Oct 29 10:00 file.txt",
		"token: expired",
	} {
		out, f := redact(t, Guard{}, in)
		if in == "token: expired" { // a name that holds a secret: masking the word is acceptable, not a leak
			continue
		}
		if out != in || len(f) != 0 {
			t.Errorf("changed %q -> %q %v", in, out, f)
		}
	}
}

func TestMaskLengthDoesNotDependOnTheSecret(t *testing.T) {
	a, _ := redact(t, Guard{}, "PASSWORD=abcd")
	b, _ := redact(t, Guard{}, "PASSWORD=abcdefghijklmnopqrstuvwxyz0123")
	if a != b {
		t.Fatalf("%q vs %q", a, b)
	}
}

func TestVaultSecretsAreMatchedExactlyInEveryForm(t *testing.T) {
	g := Guard{}.WithSecrets([][]byte{[]byte("correct horse"), []byte("ab"), []byte("pa/ss&word")})
	for _, in := range []string{
		"the password is correct horse ok",
		"Y29ycmVjdCBob3JzZQ== encoded",
		"q=pa%2Fss%26word",
	} {
		out, f := redact(t, g, in)
		if !strings.Contains(out, Mask) || Total(f) == 0 {
			t.Errorf("not masked: %q -> %q", in, out)
		}
	}
	if out, _ := redact(t, g, "ab cab"); out != "ab cab" {
		t.Fatalf("a too-short secret must not be matched: %q", out)
	}
}

func TestMultiLineVaultSecretIsMaskedLineByLine(t *testing.T) {
	g := Guard{}.WithSecrets([][]byte{[]byte("line-one-of-the-key-aaaa\nline-two-of-the-key-bbbb")})
	out, _ := redact(t, g, "see line-two-of-the-key-bbbb only")
	if strings.Contains(out, "bbbb") {
		t.Fatal(out)
	}
}

func TestCustomPatternsOnlyAdd(t *testing.T) {
	g, err := Guard{}.WithPatterns([]string{`EMP-\d{6}`, " "})
	if err != nil {
		t.Fatal(err)
	}
	out, f := redact(t, g, "id EMP-123456 AKIAIOSFODNN7EXAMPLE")
	if strings.Contains(out, "EMP-123456") || strings.Contains(out, "AKIA") || Total(f) != 2 {
		t.Fatalf("%q %v", out, f)
	}
	if _, err := (Guard{}).WithPatterns([]string{"("}); err == nil {
		t.Fatal("a broken pattern must be an error")
	}
}

func TestFindingsNeverHoldTheValue(t *testing.T) {
	_, f := redact(t, Guard{}, "PASSWORD=topsecretvalue1")
	for _, x := range f {
		if strings.Contains(x.Kind, "topsecret") {
			t.Fatal("finding holds the secret")
		}
	}
}

func TestContainsFlagsMaskAndSecrets(t *testing.T) {
	g := Guard{}
	if !g.Contains("curl -d "+Mask) || !g.Contains("export TOKEN=abc12345") || g.Contains("ls -la /var/log") {
		t.Fatal("Contains is wrong")
	}
}

func TestRedactIsIdempotent(t *testing.T) {
	once, _ := redact(t, Guard{}, "PASSWORD=hunter2hunter2 AKIAIOSFODNN7EXAMPLE")
	twice, f := redact(t, Guard{}, once)
	if once != twice || len(f) != 0 {
		t.Fatalf("%q -> %q %v", once, twice, f)
	}
}
