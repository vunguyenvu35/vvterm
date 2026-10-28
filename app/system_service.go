package app

import (
	"context"
	"errors"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// SystemService offers native dialogs and app info. It is the only place that touches the
// Wails runtime for dialogs.
type SystemService struct{ ctx context.Context }

func NewSystemService() *SystemService { return &SystemService{} }

// SetContext is called from OnStartup with the Wails context.
func (s *SystemService) SetContext(ctx context.Context) { s.ctx = ctx }

type AppInfo struct {
	Version string `json:"version"`
}

func (s *SystemService) Info() AppInfo { return AppInfo{Version: Version} }

var errNoDialog = errors.New("native dialogs are not available in this environment")

func (s *SystemService) PickFile(title string) (string, error) {
	if s.ctx == nil {
		return "", errNoDialog
	}
	return runtime.OpenFileDialog(s.ctx, runtime.OpenDialogOptions{Title: title, ShowHiddenFiles: true})
}

func (s *SystemService) PickDirectory(title string) (string, error) {
	if s.ctx == nil {
		return "", errNoDialog
	}
	return runtime.OpenDirectoryDialog(s.ctx, runtime.OpenDialogOptions{Title: title, CanCreateDirectories: true})
}

func (s *SystemService) SaveFile(title, defaultName string) (string, error) {
	if s.ctx == nil {
		return "", errNoDialog
	}
	return runtime.SaveFileDialog(s.ctx, runtime.SaveDialogOptions{Title: title, DefaultFilename: defaultName})
}
