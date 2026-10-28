// Command demoserver runs the in-process test SSH server standalone, for demos, screenshots and
// manual testing. It is not a real shell: it prints READY and echoes each line.
package main

import (
	"flag"
	"fmt"
	"os"
	"os/signal"

	"vvterm/internal/testssh"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:2222", "listen address")
	user := flag.String("user", "demo", "accepted username")
	pass := flag.String("password", "demo-password", "accepted password")
	name := flag.String("name", "demo", "name shown in the banner/prompt")
	flag.Parse()

	srv, err := testssh.StartOn(*addr, testssh.Config{
		User: *user, Password: *pass,
		Banner: "Welcome to " + *name + " (VVTerm demo server: lines are echoed back)",
		Prompt: *user + "@" + *name + ":~$ ",
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	defer srv.Close()
	fmt.Printf("demo ssh server on %s (user=%s password=%s)\n", srv.Addr, *user, *pass)
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	<-c
}
