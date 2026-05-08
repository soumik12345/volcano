declare module "*.svelte" {
	const component: unknown;
	export default component;
}

declare module "*.wasm" {
	const base64: string;
	export default base64;
}