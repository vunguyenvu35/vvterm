package syncgit

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"vvterm/internal/domain"
	"vvterm/internal/vault"
)

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func host(id, label string, at time.Duration) domain.Host {
	return domain.Host{Meta: domain.Meta{ID: id, UpdatedAt: t0.Add(at)}, Label: label, Hostname: label, Port: 22}
}

func tomb(h domain.Host, at time.Duration) domain.Host {
	d := t0.Add(at)
	h.DeletedAt = &d
	h.UpdatedAt = d
	return h
}

func bundleOf(hs ...domain.Host) Bundle { return Bundle{Data: domain.Data{Hosts: hs}} }

func labels(b Bundle) map[string]bool {
	m := map[string]bool{}
	for _, h := range b.Data.Hosts {
		if !h.Deleted() {
			m[h.Label] = true
		}
	}
	return m
}

func TestMergeUnionOfDisjointRecords(t *testing.T) {
	m := Merge(bundleOf(host("a", "A", 0)), bundleOf(host("b", "B", 0)))
	if l := labels(m); !l["A"] || !l["B"] || len(m.Data.Hosts) != 2 {
		t.Fatalf("%+v", m.Data.Hosts)
	}
}

func TestMergeLastWriteWins(t *testing.T) {
	m := Merge(bundleOf(host("a", "old", 0)), bundleOf(host("a", "new", time.Minute)))
	if !labels(m)["new"] || len(m.Data.Hosts) != 1 {
		t.Fatalf("%+v", m.Data.Hosts)
	}
	m = Merge(bundleOf(host("a", "newer-local", time.Hour)), bundleOf(host("a", "older-remote", time.Minute)))
	if !labels(m)["newer-local"] {
		t.Fatalf("%+v", m.Data.Hosts)
	}
}

func TestMergeTombstoneRules(t *testing.T) {
	base := host("a", "A", 0)
	// tombstone newer than edit -> deleted
	m := Merge(bundleOf(base), bundleOf(tomb(base, time.Hour)))
	if len(labels(m)) != 0 {
		t.Fatal("newer tombstone must delete")
	}
	// edit newer than tombstone -> restored
	edited := host("a", "A-edited", 2*time.Hour)
	m = Merge(bundleOf(tomb(base, time.Hour)), bundleOf(edited))
	if !labels(m)["A-edited"] {
		t.Fatal("newer edit must restore")
	}
	// tombstone on the local side, older remote edit -> stays deleted
	m = Merge(bundleOf(tomb(base, time.Hour)), bundleOf(host("a", "A-old", time.Minute)))
	if len(labels(m)) != 0 || len(m.Data.Hosts) != 1 {
		t.Fatal("older edit must not resurrect")
	}
	// tie: tombstone wins, in both argument orders
	for _, pair := range [][2]Bundle{
		{bundleOf(tomb(base, time.Hour)), bundleOf(host("a", "x", time.Hour))},
		{bundleOf(host("a", "x", time.Hour)), bundleOf(tomb(base, time.Hour))},
	} {
		if len(labels(Merge(pair[0], pair[1]))) != 0 {
			t.Fatal("tie must resolve to deleted")
		}
	}
}

func TestMergeIsCommutativeOnDistinctTimestamps(t *testing.T) {
	a := Bundle{Data: domain.Data{
		Hosts:  []domain.Host{host("1", "a1", 0), host("2", "a2", time.Hour)},
		Groups: []domain.Group{{Meta: domain.Meta{ID: "g", UpdatedAt: t0}, Name: "ga"}},
	}}
	b := Bundle{Data: domain.Data{
		Hosts:  []domain.Host{host("2", "b2", 2*time.Hour), host("3", "b3", 0)},
		Groups: []domain.Group{{Meta: domain.Meta{ID: "g", UpdatedAt: t0.Add(time.Minute)}, Name: "gb"}},
	}}
	ab, ba := Merge(a, b), Merge(b, a)
	if len(labels(ab)) != 3 || len(labels(ba)) != 3 {
		t.Fatal("size mismatch")
	}
	for l := range labels(ab) {
		if !labels(ba)[l] {
			t.Fatalf("merge not commutative: %v vs %v", labels(ab), labels(ba))
		}
	}
	if ab.Data.Groups[0].Name != "gb" || ba.Data.Groups[0].Name != "gb" {
		t.Fatal("group LWW wrong")
	}
}

func TestMergeCoversAllRecordTypes(t *testing.T) {
	l := Bundle{Data: domain.Data{Forwards: []domain.PortForward{{Meta: domain.Meta{ID: "f", UpdatedAt: t0}}},
		Identities: []domain.Identity{{Meta: domain.Meta{ID: "i", UpdatedAt: t0}, Name: "old"}}},
		Secrets: []domain.Secret{{Meta: domain.Meta{ID: "s", UpdatedAt: t0}, Ciphertext: []byte("old")}}}
	r := Bundle{Data: domain.Data{Identities: []domain.Identity{{Meta: domain.Meta{ID: "i", UpdatedAt: t0.Add(time.Second)}, Name: "new"}}},
		Secrets: []domain.Secret{{Meta: domain.Meta{ID: "s", UpdatedAt: t0.Add(time.Second)}, Ciphertext: []byte("new")}, {Meta: domain.Meta{ID: "s2", UpdatedAt: t0}}}}
	m := Merge(l, r)
	if len(m.Data.Forwards) != 1 || m.Data.Identities[0].Name != "new" || len(m.Secrets) != 2 || string(m.Secrets[0].Ciphertext) != "new" {
		t.Fatalf("%+v", m)
	}
}

func TestPurgeTombstones(t *testing.T) {
	live := host("a", "A", 0)
	oldDead := tomb(host("b", "B", 0), time.Hour)
	newDead := tomb(host("c", "C", 0), 100*time.Hour)
	out := PurgeTombstones(bundleOf(live, oldDead, newDead), t0.Add(50*time.Hour))
	if len(out.Data.Hosts) != 2 {
		t.Fatalf("%+v", out.Data.Hosts)
	}
}

// ---- git integration ----

func needGit(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
}

func bareRemote(t *testing.T) string {
	t.Helper()
	needGit(t)
	dir := filepath.Join(t.TempDir(), "remote.git")
	if out, err := exec.Command("git", "init", "-q", "--bare", "-b", "main", dir).CombinedOutput(); err != nil {
		t.Fatalf("%v %s", err, out)
	}
	return dir
}

type machine struct {
	v    *vault.Vault
	repo *Repo
}

// newMachine builds a machine with its own vault. If shareFrom is set, the vault is adopted
// from that machine's header (as a fresh install would after cloning).
func newMachine(t *testing.T, remote string, shareFrom *machine) *machine {
	t.Helper()
	v, err := vault.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	v.SetKDF(vault.KDFParams{Memory: 64, Time: 1, Threads: 1})
	if shareFrom == nil {
		if err := v.Create("a long master password"); err != nil {
			t.Fatal(err)
		}
	} else {
		h, _ := shareFrom.v.Header()
		if err := v.Adopt("a long master password", h, nil); err != nil {
			t.Fatal(err)
		}
	}
	r := &Repo{Dir: filepath.Join(t.TempDir(), "sync"), URL: remote}
	if err := r.Init(); err != nil {
		t.Fatal(err)
	}
	return &machine{v, r}
}

func (m *machine) sync(t *testing.T, b Bundle) Result {
	t.Helper()
	h, _ := m.v.Header()
	res, err := m.repo.Sync(b, h, m.v)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	return res
}

func TestFirstSyncPublishesEncryptedBundle(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	res := a.sync(t, bundleOf(host("h1", "secret-internal-host", 0)))
	if !res.Pushed {
		t.Fatal("first sync must push")
	}
	// inspect what is actually in the remote
	out, err := exec.Command("git", "-C", remote, "show", "main:"+BundleFile).Output()
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(out, []byte("secret-internal-host")) {
		t.Fatal("hostnames leaked in remote bundle")
	}
	files, _ := exec.Command("git", "-C", remote, "ls-tree", "--name-only", "main").Output()
	if string(files) != HeaderFile+"\n"+BundleFile+"\n" && string(files) != BundleFile+"\n"+HeaderFile+"\n" {
		t.Fatalf("unexpected repo content: %q", files)
	}
	var hdr vault.Header
	hb, _ := exec.Command("git", "-C", remote, "show", "main:"+HeaderFile).Output()
	if err := json.Unmarshal(hb, &hdr); err != nil || len(hdr.WrappedDEK) == 0 {
		t.Fatalf("header: %v", err)
	}
}

func TestTwoMachinesConvergeAndSecondSyncIsNoop(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	b := newMachine(t, remote, a)

	a.sync(t, bundleOf(host("h1", "from-a", 0)))
	resB := b.sync(t, bundleOf(host("h2", "from-b", 0)))
	if l := labels(resB.Merged); !l["from-a"] || !l["from-b"] {
		t.Fatalf("B did not receive A's host: %v", l)
	}
	resA := a.sync(t, bundleOf(host("h1", "from-a", 0)))
	if l := labels(resA.Merged); !l["from-b"] {
		t.Fatalf("A did not receive B's host: %v", l)
	}
	again := a.sync(t, resA.Merged)
	if again.Pushed {
		t.Fatal("sync with no changes must not create a commit")
	}
}

func TestDeletePropagatesViaTombstone(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	b := newMachine(t, remote, a)
	h := host("h1", "doomed", 0)
	a.sync(t, bundleOf(h))
	b.sync(t, Bundle{})
	a.sync(t, bundleOf(tomb(h, time.Hour)))
	res := b.sync(t, bundleOf(h)) // B still has the live copy
	if len(labels(res.Merged)) != 0 {
		t.Fatal("deletion did not propagate")
	}
}

func TestSecretsTravelThroughSync(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	b := newMachine(t, remote, a)
	id, err := a.v.AddSecret(domain.SecretPassword, []byte("db-password"))
	if err != nil {
		t.Fatal(err)
	}
	a.sync(t, Bundle{Secrets: a.v.Secrets()})
	res := b.sync(t, Bundle{})
	if err := b.v.ReplaceSecrets(res.Merged.Secrets); err != nil {
		t.Fatal(err)
	}
	got, err := b.v.GetSecret(id)
	if err != nil || string(got) != "db-password" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestPushRaceIsRetriedAndNothingIsLost(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	b := newMachine(t, remote, a)
	a.sync(t, bundleOf(host("base", "base", 0)))
	b.sync(t, Bundle{})

	// While A is between fetch and push, B pushes. racer fires on A's first seal.
	racer := &raceSealer{Vault: a.v, onFirstSeal: func() { b.sync(t, bundleOf(host("hb", "pushed-by-b", 0))) }}
	h, _ := a.v.Header()
	res, err := a.repo.Sync(bundleOf(host("ha", "pushed-by-a", 0)), h, racer)
	if err != nil {
		t.Fatalf("sync: %v", err)
	}
	if res.Attempts < 2 {
		t.Fatalf("expected a retry, attempts=%d", res.Attempts)
	}
	final := b.sync(t, Bundle{})
	l := labels(final.Merged)
	if !l["pushed-by-a"] || !l["pushed-by-b"] {
		t.Fatalf("lost update after race: %v", l)
	}
}

type raceSealer struct {
	*vault.Vault
	onFirstSeal func()
	done        bool
}

func (r *raceSealer) SealBlob(p, aad []byte) ([]byte, error) {
	if !r.done {
		r.done = true
		r.onFirstSeal()
	}
	return r.Vault.SealBlob(p, aad)
}

func TestForeignVaultIsRejected(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	a.sync(t, bundleOf(host("h", "h", 0)))
	other := newMachine(t, remote, nil) // independent vault, different DEK
	h, _ := other.v.Header()
	if _, err := other.repo.Sync(Bundle{}, h, other.v); !errors.Is(err, ErrVaultMismatch) {
		t.Fatalf("got %v", err)
	}
}

func TestTamperedRemoteBundleIsRejected(t *testing.T) {
	remote := bareRemote(t)
	a := newMachine(t, remote, nil)
	b := newMachine(t, remote, a)
	a.sync(t, bundleOf(host("h", "h", 0)))
	// corrupt the bundle in the remote through a scratch clone
	scratch := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.name=x", "-c", "user.email=x@x"}, args...)...)
		cmd.Dir = scratch
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v %s", err, out)
		}
	}
	run("clone", "-q", remote, ".")
	p := filepath.Join(scratch, BundleFile)
	raw, _ := os.ReadFile(p)
	raw[len(raw)-1] ^= 0xff
	os.WriteFile(p, raw, 0o600)
	run("commit", "-qam", "tamper")
	run("push", "-q", "origin", "main")

	h, _ := b.v.Header()
	if _, err := b.repo.Sync(Bundle{}, h, b.v); !errors.Is(err, ErrVaultMismatch) {
		t.Fatalf("tampered bundle accepted: %v", err)
	}
}

func TestInitValidatesURL(t *testing.T) {
	needGit(t)
	for _, url := range []string{"", "--upload-pack=evil"} {
		r := &Repo{Dir: t.TempDir(), URL: url}
		if err := r.Init(); err == nil {
			t.Errorf("url %q accepted", url)
		}
	}
}

func TestUnreachableRemoteReportsError(t *testing.T) {
	needGit(t)
	r := &Repo{Dir: t.TempDir(), URL: filepath.Join(t.TempDir(), "does-not-exist.git")}
	if err := r.Init(); err != nil {
		t.Fatal(err)
	}
	if err := r.Fetch(); err == nil {
		t.Fatal("expected fetch error")
	}
}

func TestSnippetsMergeLikeOtherRecords(t *testing.T) {
	snip := func(id, label string, at time.Duration) domain.Snippet {
		return domain.Snippet{Meta: domain.Meta{ID: id, UpdatedAt: t0.Add(at)}, Label: label, Script: "echo " + label}
	}
	local := Bundle{Data: domain.Data{Snippets: []domain.Snippet{snip("a", "old", 0), snip("only-local", "L", 0)}}}
	remote := Bundle{Data: domain.Data{Snippets: []domain.Snippet{snip("a", "new", time.Minute), snip("only-remote", "R", 0)}}}
	m := Merge(local, remote)
	got := map[string]string{}
	for _, s := range m.Data.Snippets {
		got[s.ID] = s.Label
	}
	if len(got) != 3 || got["a"] != "new" || got["only-local"] != "L" || got["only-remote"] != "R" {
		t.Fatalf("%v", got)
	}
	dead := snip("a", "x", time.Hour)
	d := t0.Add(time.Hour)
	dead.DeletedAt = &d
	m = Merge(Bundle{Data: domain.Data{Snippets: []domain.Snippet{snip("a", "edit", time.Minute)}}}, Bundle{Data: domain.Data{Snippets: []domain.Snippet{dead}}})
	if m.Data.Snippets[0].DeletedAt == nil {
		t.Fatal("newer tombstone must win")
	}
}
