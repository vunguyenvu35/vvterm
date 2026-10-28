// Package archtest enforces the dependency rule of the clean architecture:
//
//	app (delivery) -> usecase -> domain
//	infrastructure (store, vault, sshx, ...) -> domain
//
// Source-level dependencies only point inward. See docs/CleanArchitecture.md.
package archtest

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const mod = "vvterm"

// imports returns the import paths used by non-test files of a package directory (relative to the repo root).
func imports(t *testing.T, dir string) map[string]bool {
	t.Helper()
	root := filepath.Join("..", "..", dir)
	out := map[string]bool{}
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && p != root {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(p, ".go") || strings.HasSuffix(p, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), p, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, im := range f.Imports {
			out[strings.Trim(im.Path.Value, `"`)] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func internalDeps(imps map[string]bool) []string {
	var out []string
	for p := range imps {
		if p == mod || strings.HasPrefix(p, mod+"/") {
			out = append(out, strings.TrimPrefix(p, mod+"/"))
		}
	}
	sort.Strings(out)
	return out
}

func TestDomainDependsOnNothingInternal(t *testing.T) {
	if deps := internalDeps(imports(t, "internal/domain")); len(deps) != 0 {
		t.Fatalf("domain must not import project packages, got %v", deps)
	}
}

func TestDomainHasNoFrameworkDependencies(t *testing.T) {
	for p := range imports(t, "internal/domain") {
		if strings.Contains(p, "wails") || strings.Contains(p, "x/crypto/ssh") {
			t.Fatalf("domain imports framework/infra package %s", p)
		}
	}
}

// Infrastructure that the use cases still reference directly. This list is the documented
// technical debt: it may shrink (when a port replaces the dependency) but must never grow.
var usecaseAllowedInfra = map[string]bool{
	"internal/sshx":     true, // SSH transport (planned port: Connector)
	"internal/forward":  true, // port forwarding engine
	"internal/importer": true, // ssh_config parsing
	"internal/exporter": true, // ssh_config / backup writers
	"internal/syncgit":  true, // git transport for sync
	"internal/vault":    true, // key parsing helpers and keychain types
}

func TestUseCaseDependsOnlyInward(t *testing.T) {
	imps := imports(t, "internal/usecase")
	for p := range imps {
		if strings.Contains(p, "wailsapp") {
			t.Errorf("usecase must not import the UI framework: %s", p)
		}
	}
	for _, d := range internalDeps(imps) {
		switch {
		case d == "internal/domain" || d == "internal/fsutil":
		case usecaseAllowedInfra[d]:
		case d == "app":
			t.Errorf("usecase must not import the delivery layer")
		case d == "internal/store":
			t.Errorf("usecase must reach persistence through the Repository port, not %s", d)
		default:
			t.Errorf("usecase imports %s which is not on the allowed list (add a port instead)", d)
		}
	}
}

func TestInfrastructureNeverImportsUseCasesOrDelivery(t *testing.T) {
	for _, pkg := range []string{"store", "vault", "sshx", "forward", "importer", "exporter", "syncgit", "fsutil", "testssh", "sqlitedb", "sftpx"} {
		for _, d := range internalDeps(imports(t, "internal/"+pkg)) {
			if d == "app" || d == "internal/usecase" {
				t.Errorf("infrastructure package %s imports %s (dependency points outward)", pkg, d)
			}
		}
	}
}

func TestOnlyDeliveryLayerTouchesWails(t *testing.T) {
	for _, pkg := range []string{"internal/usecase", "internal/domain", "internal/store", "internal/vault", "internal/sshx",
		"internal/forward", "internal/importer", "internal/exporter", "internal/syncgit", "internal/sqlitedb", "internal/sftpx"} {
		for p := range imports(t, pkg) {
			if strings.Contains(p, "wailsapp") {
				t.Errorf("%s imports Wails (%s)", pkg, p)
			}
		}
	}
}
