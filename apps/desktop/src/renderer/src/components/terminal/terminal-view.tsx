import "@xterm/xterm/css/xterm.css";

import { consumeEventIterator } from "@orpc/client";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";

import { client } from "../../lib/client";
import { TERMINAL_THEME } from "../../lib/terminal-theme";

interface TerminalViewProps {
	terminalId: string;
	isVisible: boolean;
}

export function TerminalView({ terminalId, isVisible }: TerminalViewProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const terminalRef = useRef<Terminal | null>(null);
	const fitAddonRef = useRef<FitAddon | null>(null);
	const webglAddonRef = useRef<WebglAddon | null>(null);
	const cancelSubscriptionRef = useRef<(() => Promise<void>) | null>(null);
	const isVisibleRef = useRef(isVisible);
	isVisibleRef.current = isVisible;

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
			scrollback: 1000,
			theme: TERMINAL_THEME,
		});

		const fitAddon = new FitAddon();
		terminal.loadAddon(fitAddon);

		// Try WebGL renderer for better performance, fallback to canvas
		try {
			const webglAddon = new WebglAddon();
			webglAddon.onContextLoss(() => {
				webglAddon.dispose();
				webglAddonRef.current = null;
			});
			terminal.loadAddon(webglAddon);
			webglAddonRef.current = webglAddon;
		} catch {
			console.warn("WebGL addon failed, using canvas renderer");
		}

		terminal.open(containerRef.current);

		terminalRef.current = terminal;
		fitAddonRef.current = fitAddon;

		// Handle user input → send to PTY via oRPC
		// Note: Uses direct client calls (not TanStack Query mutations) for high-frequency
		// fire-and-forget operations that don't need cache invalidation or loading states
		const dataDisposable = terminal.onData((data) => {
			client.terminal.write({ terminalId, data }).catch((err) => {
				console.error("[Terminal] Write failed:", err);
			});
		});

		// Sync resize to PTY via oRPC
		const resizeDisposable = terminal.onResize(({ cols, rows }) => {
			client.terminal.resize({ terminalId, cols, rows }).catch((err) => {
				console.error("[Terminal] Resize failed:", err);
			});
		});

		// Fit terminal and sync initial size to PTY
		// The initial cols/rows are not set when creating PTY, so we must resize here.
		// See: https://github.com/vercel/hyper/blob/canary/lib/components/term.tsx#L290-291
		requestAnimationFrame(() => {
			fitAddon.fit();
			// Manually trigger resize to sync initial size to PTY
			client.terminal.resize({ terminalId, cols: terminal.cols, rows: terminal.rows }).catch((err) => {
				console.error("[Terminal] Initial resize failed:", err);
			});
			// Focus terminal if visible on mount (use ref to get current value)
			// Double rAF ensures React state updates are flushed and DOM is painted
			requestAnimationFrame(() => {
				if (isVisibleRef.current) {
					terminal.focus();
				}
			});
		});

		// Track if this effect instance is still active (for StrictMode)
		let isActive = true;

		// Subscribe to terminal output via oRPC streaming using consumeEventIterator
		const cancel = consumeEventIterator(client.terminal.subscribe({ terminalId }), {
			onEvent: (event) => {
				if (!isActive) return;
				const term = terminalRef.current;
				if (!term) return;
				if (event.type === "data") {
					term.write(event.data);
				} else if (event.type === "exit") {
					term.writeln("\r\n[Process exited]");
				}
			},
			onError: (error) => {
				// Ignore AbortError - expected when component unmounts
				if (error instanceof Error && error.name === "AbortError") {
					return;
				}
				console.error("[Terminal] Subscription error:", error);
			},
		});
		cancelSubscriptionRef.current = cancel;

		// Cleanup
		return () => {
			isActive = false;
			cancelSubscriptionRef.current?.();
			dataDisposable.dispose();
			resizeDisposable.dispose();
			// Dispose WebGL addon before terminal to release GPU resources
			webglAddonRef.current?.dispose();
			webglAddonRef.current = null;
			terminal.dispose();
			terminalRef.current = null;
			fitAddonRef.current = null;
			cancelSubscriptionRef.current = null;
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

	// Handle container resize with debounce
	// Created once on mount - uses isVisibleRef to check current visibility
	useEffect(() => {
		if (!containerRef.current) return;

		let resizeTimeout: ReturnType<typeof setTimeout> | null = null;

		const resizeObserver = new ResizeObserver((entries) => {
			// Only process if terminal is initialized and visible (use ref for current value)
			if (!isVisibleRef.current || !fitAddonRef.current || !terminalRef.current) return;

			const entry = entries[0];
			if (!entry) return;

			// Check if container has actual dimensions
			const { width, height } = entry.contentRect;
			if (width === 0 || height === 0) return;

			// Debounce resize to avoid excessive calls
			if (resizeTimeout) {
				clearTimeout(resizeTimeout);
			}
			resizeTimeout = setTimeout(() => {
				fitAddonRef.current?.fit();
				resizeTimeout = null;
			}, 16); // ~60fps
		});

		resizeObserver.observe(containerRef.current);
		return () => {
			if (resizeTimeout) {
				clearTimeout(resizeTimeout);
			}
			resizeObserver.disconnect();
		};
	}, []);

	return (
		<div
			ref={containerRef}
			className="absolute inset-0"
			style={{ visibility: isVisible ? "visible" : "hidden" }}
		/>
	);
}
