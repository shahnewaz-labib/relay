package main

import (
	"fmt"
	"log"
	"os/exec"
)

// firewall manages UFW rules for dynamically assigned public ports.
//
// It is strictly opt-in (--manage-firewall) because it requires a sudoers
// grant. Commands are executed without a shell, with arguments generated
// internally from integer ports — there is no injection surface from tunnel
// names or visitor input.
type firewall struct {
	enabled bool
}

func newFirewall(manage bool) *firewall {
	f := &firewall{enabled: manage}
	if !manage {
		return f
	}
	out, err := exec.Command("sudo", "-n", "ufw", "version").CombinedOutput()
	if err != nil {
		log.Printf("--manage-firewall set, but cannot run 'sudo -n ufw': %v\n"+
			"  install the sudoers rule (see README) or drop the flag; "+
			"continuing WITHOUT firewall management.\n  output: %s",
			err, firstLine(out))
		f.enabled = false
		return f
	}
	log.Printf("managing ufw rules (%s)", firstLine(out))
	return f
}

func (f *firewall) Allow(port int) {
	f.run("allow", fmt.Sprint(port))
}

func (f *firewall) Deny(port int) {
	f.run("delete", "allow", fmt.Sprint(port))
}

func (f *firewall) run(args ...string) {
	if !f.enabled || len(args) == 0 {
		return
	}
	portArg := fmt.Sprintf("%s/tcp", args[len(args)-1])
	final := append([]string{"-n", "ufw"}, args[:len(args)-1]...)
	final = append(final, portArg)

	out, err := exec.Command("sudo", final...).CombinedOutput()
	if err != nil {
		log.Printf("warning: ufw %-v failed: %v (%s)", final[2:], err, firstLine(out))
	} else {
		log.Printf("firewall: ufw %v", final[2:])
	}
}

func firstLine(b []byte) string {
	for i, c := range b {
		if c == '\n' {
			return string(b[:i])
		}
	}
	return string(b)
}
