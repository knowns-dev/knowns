/// <reference types="vite/client" />

interface ImportMetaEnv {
	readonly API_URL: string;
	readonly WS_URL: string;
	readonly APP_VERSION: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
