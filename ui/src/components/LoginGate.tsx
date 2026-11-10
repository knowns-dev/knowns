import { useState, type FormEvent, type ReactNode } from "react";
import { LockKeyhole } from "lucide-react";
import { useAuth } from "@/ui/contexts/AuthContext";
import { AuthPage } from "@/ui/components/ui/knowns/blocks/auth/auth-page";
import { Button } from "@/ui/components/ui/knowns/button";
import { Field } from "@/ui/components/ui/knowns/input";
import { PasswordField } from "@/ui/components/ui/knowns/password-field";
import { Spinner } from "@/ui/components/ui/knowns/spinner";
import logoImage from "../public/logo.png";

export function LoginGate({ children }: { children: ReactNode }) {
	const { isProtected, isAuthenticated, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-background">
				<Spinner label="Loading" />
			</div>
		);
	}

	if (isProtected && !isAuthenticated) {
		return <LoginForm />;
	}

	return <>{children}</>;
}

/** The unlock screen for a password-protected server, on the Knowns UI auth page. */
function LoginForm() {
	const { login } = useAuth();
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (e: FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);
		try {
			await login(password);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Invalid password");
			setPassword("");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="fixed inset-0 overflow-auto bg-background">
			<AuthPage
				className="px-4"
				footer={<span>Password set with knowns browser --password</span>}
			>
				<div
					className="w-full max-w-sm rounded-2xl bg-card p-6 shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_10%,transparent),0_12px_32px_-16px_rgb(0_0_0/0.3)]"
				>
					<div className="mb-6 flex flex-col items-center gap-3 text-center">
						<img src={logoImage} alt="" className="h-12 w-12 rounded-xl object-contain" />
						<div>
							<h1 className="text-xl font-semibold tracking-tight">Unlock Knowns</h1>
							<p className="mt-1 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground">
								<LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
								This instance is password protected
							</p>
						</div>
					</div>
					<form onSubmit={handleSubmit} className="space-y-4">
						<Field id="knowns-password" label="Password" error={error || undefined}>
							<PasswordField
								id="knowns-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder="Enter password"
								autoFocus
								disabled={loading}
								invalid={Boolean(error)}
							/>
						</Field>
						<Button type="submit" variant="primary" className="w-full" loading={loading} disabled={!password}>
							{loading ? "Unlocking" : "Unlock"}
						</Button>
					</form>
				</div>
			</AuthPage>
		</div>
	);
}
