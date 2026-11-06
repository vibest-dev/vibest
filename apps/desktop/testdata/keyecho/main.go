package main

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func main() {
	stty := exec.Command("stty", "raw", "-echo")
	stty.Stdin = os.Stdin
	if err := stty.Run(); err != nil {
		fmt.Println("stty:", err)
		os.Exit(1)
	}
	defer func() {
		reset := exec.Command("stty", "sane")
		reset.Stdin = os.Stdin
		reset.Run()
	}()
	sum, colors, tag := false, false, ""
	for _, m := range os.Args[1:] {
		if strings.HasPrefix(m, "tag=") {
			tag = " " + m[4:]
			continue
		}
		switch m {
		case "sum":
			sum = true
		case "colors":
			colors = true
		case "override":
			fmt.Print("\x1b]4;1;rgb:12/34/56\x1b\\")
		case "paste":
			fmt.Print("\x1b[?2004h")
			defer fmt.Print("\x1b[?2004l")
		case "appcursor":
			fmt.Print("\x1b[?1h")
			defer fmt.Print("\x1b[?1l")
		case "mouse":
			fmt.Print("\x1b[?1000h\x1b[?1006h")
			defer fmt.Print("\x1b[?1006l\x1b[?1000l")
		case "kitty":
			fmt.Print("\x1b[>1u")
			defer fmt.Print("\x1b[<u")
		case "theme":
			fmt.Print("\x1b[?2031h\x1b]11;?\x1b\\")
			defer fmt.Print("\x1b[?2031l")
		}
	}
	fmt.Print("READY" + tag + "\r\n")
	buf := make([]byte, 1<<20)
	if sum {
		var all []byte
		for !bytes.Contains(all, []byte("\x1b[201~")) {
			n, err := os.Stdin.Read(buf)
			if err != nil {
				return
			}
			all = append(all, buf[:n]...)
		}
		start := bytes.Index(all, []byte("\x1b[200~"))
		end := bytes.Index(all, []byte("\x1b[201~"))
		if start < 0 || end < start {
			fmt.Printf("SUM:unbracketed n=%d\r\n", len(all))
			return
		}
		content := all[start+6 : end]
		fmt.Printf("SUM:%x n=%d\r\n", sha256.Sum256(content), len(content))
		return
	}
	for {
		n, err := os.Stdin.Read(buf)
		if err != nil {
			return
		}
		if n == 1 && buf[0] == 'q' {
			return
		}
		if colors && n == 1 && buf[0] == 'c' {
			fmt.Print("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]4;1;?\x1b\\\x1b]4;7;?\x1b\\\x1b]4;15;?\x1b\\\x1b]4;196;?\x1b\\")
			continue
		}
		if colors && bytes.HasPrefix(buf[:n], []byte("\x1b]")) {
			for _, r := range bytes.SplitAfter(buf[:n], []byte("\x1b\\")) {
				if len(r) > 0 {
					fmt.Printf("K:%x\r\n", r)
				}
			}
			continue
		}
		if n > 64 {
			fmt.Printf("K:%x..%x n=%d\r\n", buf[:8], buf[n-8:n], n)
			continue
		}
		fmt.Printf("K:%x\r\n", buf[:n])
	}
}
