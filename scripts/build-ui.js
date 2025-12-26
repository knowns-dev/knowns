import { execSync } from "child_process";

const version = process.env.npm_package_version;

if (!version) {
	throw new Error("Missing npm_package_version environment variable");
}

const command = `
  bun build src/ui/main.tsx \
    --outdir dist/ui \
    --target browser \
    --minify \
    --define process.env.APP_VERSION='"${version}"'
`;

execSync(command, { stdio: "inherit" });

const postcssCommand = "postcss src/ui/index.css -o dist/ui/index.css";

execSync(postcssCommand, { stdio: "inherit" });
