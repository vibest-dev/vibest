import "@xterm/xterm/css/xterm.css";

import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { client } from "../../lib/client";

interface TerminalViewProps {
	terminalId: string;
	isVisible: boolean;
}

export function TerminalView({ terminalId, isVisible }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const abortControllerRef = useRef<AbortController | null>(null);

	// Initialize terminal once
	useEffect(() => {
		if (!containerRef.current || terminalRef.current) return;

		const terminal = new Terminal({
			cursorBlink: true,
			cursorStyle: "block",
			fontSize: 14,
			fontFamily: '"Geist Mono Variable", Menlo, Monaco, monospace',
			fontWeight: "normal",
			lineHeight: 1.2,
			scrollback: 5000,
			theme: {
				background: "#0a0a0a",
				foreground: "#fafafa",
				cursor: "#fafafa",
				cursorAccent: "#0a0a0a",
				selectionBackground: "#3f3f46",
				black: "#09090b",
				red: "#ef4444",
				green: "#22c55e",
				yellow: "#eab308",
				blue: "#3b82f6",
				magenta: "#a855f7",
				cyan: "#06b6d4",
				white: "#fafafa",
				brightBlack: "#71717a",
				brightRed: "#f87171",
				brightGreen: "#4ade80",
				brightYellow: "#facc15",
				brightBlue: "#60a5fa",
				brightMagenta: "#c084fc",
				brightCyan: "#22d3ee",
				brightWhite: "#ffffff",
			},
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		// Try WebGL renderer with fallback
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
			});
			terminal.loadAddon(webglAddon);
		} catch {
			console.warn("WebGL addon failed, using canvas renderer");
		}

		terminal.open(containerRef.current);
		fitAddon.fit();

		terminalRef.current = terminal;
		fitAddonRef.current = fitAddon;

		// Handle user input → send to PTY via oRPC
		const dataDisposable = terminal.onData((data) => {
			client.terminal.write({ terminalId, data });
		});

		// Sync resize to PTY via oRPC
		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			client.terminal.resize({ terminalId, cols, rows });
		});

		// Subscribe to terminal output via oRPC streaming
		const abortController = new AbortController();
		abortControllerRef.current = abortController;

		(async () => {
			try {
				const iterator = await client.terminal.subscribe(
					{ terminalId },
					{ signal: abortController.signal },
				);

				for await (const event of iterator) {
					if (event.type === "data") {
						terminal.write(event.data);
					} else if (event.type === "exit") {
						terminal.writeln("\r\n[Process exited]");
						break;
					}
				}
			} catch (error) {
				// Ignore abort errors
				if (error instanceof Error && error.name === "AbortError") {
					return;
				}
				console.error("Terminal subscription error:", error);
			}
		})();

		// Cleanup
		return () => {
			abortController.abort();
			dataDisposable.dispose();
			resizeDisposable.dispose();
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			abortControllerRef.current = null;
		};
	}, [terminalId]);

	// Handle visibility changes - fit when becoming visible
	useEffect(() => {
		if (isVisible && fitAddonRef.current && terminalRef.current) {
			// Small delay to ensure container is rendered
			requestAnimationFrame(() => {
				fitAddonRef.current?.fit();
				terminalRef.current?.focus();
			});
		}
	}, [isVisible]);

	// Handle container resize
	useEffect(() => {
		if (!containerRef.current || !fitAddonRef.current) return;

		const resizeObserver = new ResizeObserver(() => {
			if (isVisible) {
				fitAddonRef.current?.fit();
			}
		});

		resizeObserver.observe(containerRef.current);
		return () => resizeObserver.disconnect();
	}, [isVisible]);

	return (
		<div
			ref={containerRef}
			className="absolute inset-0"
			style={{ display: isVisible ? "block" : "none" }}
		/>
	);
}
