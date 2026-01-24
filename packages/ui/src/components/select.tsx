import { ark, type HTMLArkProps } from "@ark-ui/react/factory";
import { Select as SelectPrimitive, selectAnatomy } from "@ark-ui/react/select";
import { cn } from "@vibest/ui/lib/utils";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

const parts = selectAnatomy.extendWith("separator").build();

function Select<T extends SelectPrimitive.CollectionItem>(
	props: SelectPrimitive.RootProps<T>,
) {
	return <SelectPrimitive.Root {...props} />;
}

function SelectClearTrigger({
	className,
	...props
}: SelectPrimitive.ClearTriggerProps) {
	return (
		<SelectPrimitive.ClearTrigger
			className={cn(
				"absolute end-0 top-0 flex size-9 items-center justify-center rounded-md border border-transparent text-muted-foreground/80 outline-none transition-[color,box-shadow] hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50",
				className,
			)}
			{...props}
		/>
	);
}

function SelectContent({ className, ...props }: SelectPrimitive.ContentProps) {
	return (
		<SelectPrimitive.Positioner>
			<SelectPrimitive.Content
				className={cn(
					"relative w-full min-w-32 overflow-hidden rounded-md border border-input bg-popover p-1 text-popover-foreground shadow-lg",
					"data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=open]:animate-in",
					"data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=left]:-translate-x-1 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2 data-[placement=top]:-translate-y-1 data-[placement=right]:translate-x-1 data-[placement=bottom]:translate-y-1",
					className,
				)}
				{...props}
			/>
		</SelectPrimitive.Positioner>
	);
}

function SelectContext<T extends SelectPrimitive.CollectionItem>(
	props: SelectPrimitive.ContextProps<T>,
) {
	return <SelectPrimitive.Context {...props} />;
}

function SelectControl({ className, ...props }: SelectPrimitive.ControlProps) {
	return (
		<SelectPrimitive.Control
			className={cn(
				"relative flex min-h-[38px] rounded-md border border-input text-sm outline-none transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 has-aria-invalid:border-destructive has-aria-invalid:ring-destructive/20 dark:has-aria-invalid:ring-destructive/40",
				className,
			)}
			{...props}
		/>
	);
}

function SelectIndicator(props: SelectPrimitive.IndicatorProps) {
	return (
		<SelectPrimitive.Indicator {...props}>
			<ChevronDownIcon className="size-4 shrink-0 in-aria-invalid:text-destructive/80 text-muted-foreground/80" />
		</SelectPrimitive.Indicator>
	);
}

function SelectItem({
	className,
	children,
	...props
}: SelectPrimitive.ItemProps) {
	return (
		<SelectPrimitive.Item
			className={cn(
				"relative flex w-full cursor-default select-none items-center rounded py-1.5 ps-8 pe-2 text-sm outline-hidden data-[disabled]:pointer-events-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		>
			<span className="absolute start-2 flex size-3.5 items-center justify-center">
				<SelectPrimitive.ItemIndicator>
					<CheckIcon size={16} />
				</SelectPrimitive.ItemIndicator>
			</span>
			<SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
		</SelectPrimitive.Item>
	);
}

function SelectItemContext(props: SelectPrimitive.ItemContextProps) {
	return <SelectPrimitive.ItemContext {...props} />;
}

function SelectItemGroup(props: SelectPrimitive.ItemGroupProps) {
	return <SelectPrimitive.ItemGroup {...props} />;
}

function SelectItemGroupLabel({
	className,
	...props
}: SelectPrimitive.ItemGroupLabelProps) {
	return (
		<SelectPrimitive.ItemGroupLabel
			className={cn(
				"py-1.5 ps-8 pe-2 font-medium text-muted-foreground text-xs",
				className,
			)}
			{...props}
		/>
	);
}

function SelectItemText({ ...props }: SelectPrimitive.ItemTextProps) {
	return <SelectPrimitive.ItemText {...props} />;
}

function SelectLabel({ className, ...props }: SelectPrimitive.LabelProps) {
	return (
		<SelectPrimitive.Label
			className={cn(
				"select-none font-medium text-foreground text-sm leading-4 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
				className,
			)}
			{...props}
		/>
	);
}

function SelectList({ className, ...props }: SelectPrimitive.ListProps) {
	return (
		<SelectPrimitive.List
			className={cn(
				"max-h-[min(24rem,var(--available-height))] overflow-y-auto",
				className,
			)}
			{...props}
		/>
	);
}

const SelectRootProvider = SelectPrimitive.RootProvider;

function SelectSeparator({ className, ...props }: HTMLArkProps<"hr">) {
	return (
		<ark.hr
			{...parts.separator.attrs}
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}

function SelectTrigger({ className, ...props }: SelectPrimitive.TriggerProps) {
	return (
		<SelectPrimitive.Trigger
			className={cn(
				"flex flex-1 items-center justify-between gap-1 bg-transparent px-3 py-2 outline-none outline-hidden placeholder:text-muted-foreground/70 has-disabled:pointer-events-none has-disabled:cursor-not-allowed has-disabled:opacity-50 data-[placeholder-shown]:text-muted-foreground",
				className,
			)}
			{...props}
		/>
	);
}

function SelectValueText(props: SelectPrimitive.ValueTextProps) {
	return <SelectPrimitive.ValueText {...props} />;
}

export {
	Select,
	SelectClearTrigger,
	SelectContent,
	SelectContext,
	SelectControl,
	SelectIndicator,
	SelectItem,
	SelectItemContext,
	SelectItemGroup,
	SelectItemGroupLabel,
	SelectItemText,
	SelectLabel,
	SelectList,
	SelectRootProvider,
	SelectSeparator,
	SelectTrigger,
	SelectValueText,
};

export {
	type CollectionItem,
	createListCollection,
	type ListCollection,
	type SelectHighlightChangeDetails,
	type SelectOpenChangeDetails,
	type SelectValueChangeDetails,
	useSelect,
} from "@ark-ui/react/select";
