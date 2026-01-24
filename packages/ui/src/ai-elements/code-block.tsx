"use client";

import { Button } from "@vibest/ui/components/button";
import { cn } from "@vibest/ui/lib/utils";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, JSX, ReactNode } from "react";
import {
	createContext,
	Fragment,
	Suspense,
	use,
	useContext,
	useMemo,
	useState,
} from "react";
import { jsx, jsxs } from "react/jsx-runtime";
import type { BundledLanguage, CodeToHastOptions } from "shiki/bundle/web";
import { codeToHast } from "shiki/bundle/web";

type CodeBlockContextType = {
	code: string;
};

const CodeBlockContext = createContext<CodeBlockContextType>({
	code: "",
});

async function highlight(
	code: string,
	options: CodeToHastOptions,
): Promise<JSX.Element> {
	const out = await codeToHast(code, options);

	return toJsxRuntime(out, {
		Fragment,
		jsx,
		jsxs,
	}) as JSX.Element;
}

// Fallback component for loading state
function CodeBlockFallback({ code }: { code: string }) {
	return (
		<div className="overflow-auto p-2 font-mono">
			<pre className="font-mono text-sm">{code}</pre>
		</div>
	);
}

// Internal component that uses React 19's use() for highlighting
function HighlightedCode({ promises }: { promises: Promise<JSX.Element> }) {
	// React 19's use() API - will suspend until promise resolves
	const highlighted = use(promises);

	return highlighted;
}

export type CodeBlockProps = HTMLAttributes<HTMLDivElement> & {
	code: string;
	children?: ReactNode;
	language?: string;
	codeToHastOptions?: Partial<CodeToHastOptions>;
};

export function CodeBlock({
	code,
	className,
	children,
	language,
	codeToHastOptions,
	...props
}: CodeBlockProps) {
	// Memoize the promise for dual-theme highlighting
	const highlightPromise = useMemo(() => {
		return highlight(code, {
			...codeToHastOptions,
			themes: {
				light: "github-light",
				dark: "github-dark",
			},
			lang: language ?? codeToHastOptions?.lang ?? "text",
		}).catch((error) => {
			console.error("Failed to highlight code:", error);
			return <CodeBlockFallback code={code} />;
		});
	}, [code, language, codeToHastOptions]);

	return (
		<CodeBlockContext.Provider value={{ code }}>
			<div
				className={cn(
					"relative w-full overflow-hidden rounded-md border bg-background text-foreground",
					className,
				)}
				{...props}
			>
				<Suspense fallback={<p className="p-2 text-xs">Loading...</p>}>
					<div className="overflow-auto font-mono text-sm px-4 py-3.5 scrollbar-hide">
						<HighlightedCode promises={highlightPromise} />
					</div>
				</Suspense>
				{children && (
					<div className="absolute top-1 right-2 flex items-center gap-2">
						{children}
					</div>
				)}
			</div>
		</CodeBlockContext.Provider>
	);
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	onCopy?: () => void;
	onError?: (error: Error) => void;
	timeout?: number;
};

export function CodeBlockCopyButton({
	onCopy,
	onError,
	timeout = 2000,
	children,
	className,
	...props
}: CodeBlockCopyButtonProps) {
	const [isCopied, setIsCopied] = useState(false);
	const { code } = useContext(CodeBlockContext);

	const copyToClipboard = async () => {
		if (typeof window === "undefined" || !navigator.clipboard.writeText) {
			onError?.(new Error("Clipboard API not available"));
			return;
		}

		try {
			await navigator.clipboard.writeText(code);
			setIsCopied(true);
			onCopy?.();
			setTimeout(() => setIsCopied(false), timeout);
		} catch (error) {
			onError?.(error as Error);
		}
	};

	const Icon = isCopied ? CheckIcon : CopyIcon;

	return (
		<Button
			className={cn("shrink-0", className)}
			onClick={copyToClipboard}
			size="icon"
			variant="ghost"
			{...props}
		>
			{children ?? <Icon size={14} />}
		</Button>
	);
}

export type CodeBlockLanguage = BundledLanguage;
