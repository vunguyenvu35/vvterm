package agentx

import (
	"bytes"
	"context"
	"image"
	"image/color"
	"image/png"
	"os"
	"strings"
	"testing"

	"vvterm/internal/domain/assistant"
)

// VVTERM_LIVE=1 go test ./internal/agentx -run LiveImages -v
// A solid red picture is sent to the real CLIs, which must say what colour it is.
func TestLiveImages(t *testing.T) {
	if os.Getenv("VVTERM_LIVE") != "1" {
		t.Skip("set VVTERM_LIVE=1")
	}
	img := image.NewRGBA(image.Rect(0, 0, 96, 96))
	for x := 0; x < 96; x++ {
		for y := 0; y < 96; y++ {
			img.Set(x, y, color.RGBA{R: 220, G: 20, B: 20, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	pic, err := assistant.ConfirmImage("red.png", buf.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []interface {
		Detect(context.Context) assistant.Status
		Ask(context.Context, assistant.Request, func(string)) (string, error)
		ID() string
	}{&Claude{}, &Codex{}} {
		t.Run(a.ID(), func(t *testing.T) {
			if a.Detect(context.Background()).State != assistant.StateReady {
				t.Skip("not ready")
			}
			r := liveRequest(t, "What is the main colour of the attached picture? Answer with the colour word in the explanation and no commands.")
			r.Images = []assistant.ConfirmedImage{pic}
			out, err := a.Ask(context.Background(), r, nil)
			if err != nil {
				t.Fatalf("ask: %v", err)
			}
			t.Logf("reply: %q", out)
			if !strings.Contains(strings.ToLower(out), "red") {
				t.Fatalf("the agent did not see the picture: %q", out)
			}
		})
	}
}
