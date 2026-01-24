import {
	WebPreview,
	WebPreviewBody,
	WebPreviewNavigation,
	WebPreviewNavigationButton,
	WebPreviewUrl,
} from "@vibest/ui/ai-elements/web-preview";
import {
	Splitter,
	SplitterPanel,
	SplitterResizeTrigger,
} from "@vibest/ui/components/splitter";
import { ArrowLeftIcon, ArrowRightIcon, RefreshCwIcon } from "lucide-react";
import { ToolbarProviders } from "@/context/toolbar";
import { Chat } from "@/features/vibest/components/chat";
import { useVibestClientRpcContext } from "@/rpc/vibest-client-rpc-context";

export function App() {
	const { iframeRef } = useVibestClientRpcContext();

	return (
		<div className="h-screen bg-background">
			<Splitter
				panels={[
					{ id: "chat", minSize: 25 },
					{ id: "preview", minSize: 30 },
				]}
				defaultSize={[25, 75]}
				className="flex h-full"
			>
				{/* Left Panel - Chat */}
				<SplitterPanel id="chat">
					<ToolbarProviders>
						<Chat className="h-full" />
					</ToolbarProviders>
				</SplitterPanel>

				<SplitterResizeTrigger id="chat:preview" className="" />

				{/* Right Panel - Web Preview */}
				<SplitterPanel id="preview">
					<WebPreview
						defaultUrl="/"
						className="h-full rounded-none border-none"
					>
						<WebPreviewNavigation>
							<WebPreviewNavigationButton
								tooltip="Go back"
								onClick={() => window.history.back()}
							>
								<ArrowLeftIcon className="h-4 w-4" />
							</WebPreviewNavigationButton>
							<WebPreviewNavigationButton
								tooltip="Go forward"
								onClick={() => window.history.forward()}
							>
								<ArrowRightIcon className="h-4 w-4" />
							</WebPreviewNavigationButton>
							<WebPreviewNavigationButton
								tooltip="Refresh"
								onClick={() => window.location.reload()}
							>
								<RefreshCwIcon className="h-4 w-4" />
							</WebPreviewNavigationButton>
							<WebPreviewUrl />
						</WebPreviewNavigation>
						<WebPreviewBody ref={iframeRef} />
					</WebPreview>
				</SplitterPanel>
			</Splitter>
		</div>
	);
}
