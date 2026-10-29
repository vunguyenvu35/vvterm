package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const latestReleaseURL = "https://api.github.com/repos/vunguyenvu35/vvterm/releases/latest"

// UpdateInfo is the answer of CheckUpdate: whether a newer release exists on GitHub.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"`
	URL       string `json:"url"`
	Notes     string `json:"notes"`
}

// CheckUpdate asks GitHub for the latest release and compares it with the running version. It only reads; the
// user downloads the new build from the release page (OpenURL).
func (s *SystemService) CheckUpdate() (UpdateInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return checkUpdate(ctx, http.DefaultClient, latestReleaseURL, Version)
}

func checkUpdate(ctx context.Context, c *http.Client, url, current string) (UpdateInfo, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return UpdateInfo{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "vvterm/"+current)
	resp, err := c.Do(req)
	if err != nil {
		return UpdateInfo{}, errors.New("could not reach GitHub: check your connection")
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return UpdateInfo{Current: current}, nil // no release published yet
	}
	if resp.StatusCode != http.StatusOK {
		return UpdateInfo{}, fmt.Errorf("GitHub answered %s", resp.Status)
	}
	var rel struct {
		Tag  string `json:"tag_name"`
		URL  string `json:"html_url"`
		Body string `json:"body"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(nil, resp.Body, 1<<20)).Decode(&rel); err != nil {
		return UpdateInfo{}, errors.New("unexpected answer from GitHub")
	}
	notes := rel.Body
	if len(notes) > 2000 {
		notes = notes[:2000] + "…"
	}
	return UpdateInfo{
		Current:   current,
		Latest:    strings.TrimPrefix(rel.Tag, "v"),
		Available: newerVersion(rel.Tag, current),
		URL:       rel.URL,
		Notes:     notes,
	}, nil
}

// newerVersion reports whether latest is a higher X.Y.Z than current. A build that is not a release ("dev", a
// commit hash) is never told to update.
func newerVersion(latest, current string) bool {
	l, ok1 := parseVersion(latest)
	c, ok2 := parseVersion(current)
	if !ok1 || !ok2 {
		return false
	}
	for i := range l {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func parseVersion(v string) ([3]int, bool) {
	var out [3]int
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}
