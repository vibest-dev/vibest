import { ThemeProvider as NextThemesProvider } from "next-themes";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
	return (
		<NextThemesProvider
			attribute="class"
			defaultTheme="dark"
			disableTransitionOnChange
		>
			{children}
		</NextThemesProvider>
	);
}

export { useTheme } from "next-themes";
