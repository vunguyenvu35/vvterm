package main

import (
	"context"
	"embed"
	"log"
	"os"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/mac"

	"vvterm/app"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var appIcon []byte

func main() {
	dir, err := app.DataDir()
	if err != nil {
		log.Fatalf("data dir: %v", err)
	}
	if len(os.Args) > 1 && os.Args[1] == app.SettingsFlag {
		runSettings(dir)
		return
	}
	a, err := app.Build(dir, nil, nil)
	if err != nil {
		log.Fatalf("open data: %v", err)
	}

	err = wails.Run(&options.App{
		Title:     "VVTerm",
		Width:     1280,
		Height:    800,
		MinWidth:  900,
		MinHeight: 600,
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		BackgroundColour: &options.RGBA{R: 17, G: 19, B: 24, A: 1},
		OnStartup:        func(ctx context.Context) { a.Startup(ctx); setDockIcon(appIcon) },
		OnShutdown:       a.Shutdown,
		Menu:             a.Menu(),
		Mac: &mac.Options{
			TitleBar: mac.TitleBarHiddenInset(),
			About:    &mac.AboutInfo{Title: "VVTerm", Message: "SSH client with an encrypted vault.\nVersion " + app.Version, Icon: appIcon},
		},
		Bind: []interface{}{
			a.Host, a.Vault, a.Session, a.Forward, a.Sync, a.ImportExp, a.Settings, a.Snippet, a.Sftp, a.Local, a.Serial, a.Log, a.KnownHost, a.System,
		},
	})
	if err != nil {
		log.Fatal(err)
	}
}

// runSettings is the Settings window: a second process with its own native window. It opens no database
// and no vault; everything it shows comes from the main process through the bridge.
func runSettings(dir string) {
	w, err := app.NewSettingsWindow(dir)
	if err != nil {
		log.Fatal(err)
	}
	err = wails.Run(&options.App{
		Title:            "Settings",
		Width:            1040,
		Height:           720,
		MinWidth:         720,
		MinHeight:        480,
		AssetServer:      &assetserver.Options{Assets: assets},
		BackgroundColour: &options.RGBA{R: 17, G: 19, B: 24, A: 1},
		OnStartup:        func(ctx context.Context) { w.Startup(ctx); setDockIcon(appIcon) },
		Mac:              &mac.Options{TitleBar: mac.TitleBarHiddenInset()},
		Bind:             []interface{}{w.Bridge, w.System},
	})
	if err != nil {
		log.Fatal(err)
	}
}
