import { RuntimeOverview } from "../components/organisms/RuntimeOverview";
import { PageShell } from "../components/templates/PageShell";

export default function RuntimePage() {
	return (
		<PageShell>
			<RuntimeOverview />
		</PageShell>
	);
}
