// Command demoserver runs the in-process test SSH server standalone, for demos, screenshots and
// manual testing. It is not a real shell: it prints READY and echoes each line.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"

	"golang.org/x/crypto/ssh"

	"vvterm/internal/testssh"
	"vvterm/internal/vault"
)

// loadOrCreateHostKey returns a persistent host key so restarts do not trigger "HOST KEY CHANGED".
func loadOrCreateHostKey(path string) (ssh.Signer, error) {
	if b, err := os.ReadFile(path); err == nil {
		return ssh.ParsePrivateKey(b)
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	pemBytes, _, err := vault.GenerateEd25519("vvterm-demoserver")
	if err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, pemBytes, 0o600); err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(pemBytes)
}

func main() {
	addr := flag.String("addr", "127.0.0.1:2222", "listen address")
	user := flag.String("user", "demo", "accepted username")
	pass := flag.String("password", "demo-password", "accepted password")
	name := flag.String("name", "demo", "name shown in the banner/prompt")
	hostKey := flag.String("hostkey", "", "path of a persistent host key (created if missing); random per run when empty")
	withSFTP := flag.Bool("sftp", false, "enable the sftp subsystem on an in-memory filesystem seeded with demo files")
	flag.Parse()

	cfg := testssh.Config{
		User: *user, Password: *pass,
		Banner: "Welcome to " + *name + " (VVTerm demo server: lines are echoed back)",
		Prompt: *user + "@" + *name + ":~$ ",
	}
	if *withSFTP {
		// the in-memory server's home directory is its root
		cfg.SFTP = true
		cfg.SFTPSeed = map[string]string{
			"/projects/":          "",
			"/notes.txt":          "VVTerm demo notes\n",
			"/projects/README.md": "# Demo project\n",
			"/projects/deploy.sh": "#!/bin/sh\necho deploy\n",
		}
	}
	if *hostKey != "" {
		k, err := loadOrCreateHostKey(*hostKey)
		if err != nil {
			fmt.Fprintln(os.Stderr, "host key:", err)
			os.Exit(1)
		}
		cfg.HostKey = k
	}
	srv, err := testssh.StartOn(*addr, cfg)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer srv.Close()
	fmt.Printf("demo ssh server on %s (user=%s password=%s) host key %s\n", srv.Addr, *user, *pass, ssh.FingerprintSHA256(srv.HostKey.PublicKey()))
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	<-c
}
