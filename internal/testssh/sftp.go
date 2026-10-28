package testssh

import (
	"path"
	"strings"

	"github.com/pkg/sftp"
)

// SFTP open flags (SSH_FXF_*) needed to create a file through the handlers directly.
const fxfWrite, fxfCreat, fxfTrunc = 0x2, 0x8, 0x10

// seedSFTP fills the in-memory filesystem by calling its handlers directly.
func seedSFTP(h sftp.Handlers, seed map[string]string) error {
	mkdirAll := func(dir string) error {
		cur := ""
		for _, part := range strings.Split(strings.Trim(path.Clean(dir), "/"), "/") {
			if part == "" || part == "." {
				continue
			}
			cur += "/" + part
			if err := h.FileCmd.Filecmd(&sftp.Request{Method: "Mkdir", Filepath: cur}); err != nil && !isExists(err) {
				return err
			}
		}
		return nil
	}
	for p, content := range seed {
		if strings.HasSuffix(p, "/") {
			if err := mkdirAll(p); err != nil {
				return err
			}
			continue
		}
		if err := mkdirAll(path.Dir(p)); err != nil {
			return err
		}
		w, err := h.FilePut.Filewrite(&sftp.Request{Method: "Put", Filepath: p, Flags: fxfWrite | fxfCreat | fxfTrunc})
		if err != nil {
			return err
		}
		if _, err := w.WriteAt([]byte(content), 0); err != nil {
			return err
		}
		if c, ok := w.(interface{ Close() error }); ok {
			_ = c.Close()
		}
	}
	return nil
}

func isExists(err error) bool {
	return err != nil && strings.Contains(strings.ToLower(err.Error()), "exist")
}
