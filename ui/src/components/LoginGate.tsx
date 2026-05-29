import { useState, type FormEvent } from "react";
import { useAuth } from "@/ui/contexts/AuthContext";

export function LoginGate({ children }: { children: React.ReactNode }) {
	const { isProtected, isAuthenticated, isLoading } = useAuth();

	if (isLoading) {
		return (
			<div className="fixed inset-0 flex items-center justify-center bg-background">
				<div className="animate-pulse text-muted-foreground">Loading...</div>
			</div>
		);
	}

	if (isProtected && !isAuthenticated) {
		return <LoginForm />;
	}

	return <>{children}</>;
}

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
		<div className="fixed inset-0 flex items-center justify-center bg-background">
			<div className="w-full max-w-sm p-6 space-y-6">
				<div className="text-center space-y-2">
					<h1 className="text-2xl font-bold">Knowns</h1>
					<p className="text-sm text-muted-foreground">This instance is password protected</p>
				</div>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<input
							type="password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="Enter password"
							className="w-full px-3 py-2 border rounded-md bg-background text-foreground border-border focus:outline-none focus:ring-2 focus:ring-ring"
							autoFocus
							disabled={loading}
						/>
					</div>
					{error && (
						<p className="text-sm text-destructive">{error}</p>
					)}
					<button
						type="submit"
						disabled={loading || !password}
						className="w-full px-3 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed"
					>
						{loading ? "Authenticating..." : "Unlock"}
					</button>
				</form>
			</div>
		</div>
	);
}
