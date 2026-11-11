import { useEffect, useState } from "react";
import { Check, Copy, Power, PowerOff } from "lucide-react";
import { Button } from "@/ui/components/ui/knowns/button";
import { Input } from "@/ui/components/ui/knowns/input";
import { DangerZone, SettingsRow, SettingsSection } from "@/ui/components/ui/knowns/blocks/settings/settings-layout";
import { toast } from "@/ui/components/ui/sonner";
import { tunnelApi } from "@/ui/api/client";
import { useAuth } from "@/ui/contexts/AuthContext";

/** Who can reach this server: the password and the public tunnel, together because one warns about the other. */
export function AccessSection() {
	const { isProtected, setPassword, removePassword } = useAuth();
	const [newPassword, setNewPassword] = useState("");
	const [passwordBusy, setPasswordBusy] = useState(false);
	const [tunnel, setTunnel] = useState<{ running: boolean; url?: string }>({ running: false });
	const [tunnelBusy, setTunnelBusy] = useState(false);
	const [tunnelError, setTunnelError] = useState<string | null>(null);

	useEffect(() => {
		tunnelApi.getStatus().then(setTunnel).catch(() => {});
	}, []);

	const handleSetPassword = async () => {
		if (!newPassword) return;
		setPasswordBusy(true);
		try {
			await setPassword(newPassword);
			setNewPassword("");
			toast.success("Password protection enabled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to set password");
		} finally {
			setPasswordBusy(false);
		}
	};

	const handleRemovePassword = async () => {
		setPasswordBusy(true);
		try {
			await removePassword();
			toast.success("Password protection disabled");
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "Failed to remove password");
		} finally {
			setPasswordBusy(false);
		}
	};

	const startTunnel = async () => {
		setTunnelBusy(true);
		setTunnelError(null);
		try {
			const result = await tunnelApi.start();
			setTunnel({ running: true, url: result.url });
			toast.success(`Tunnel active: ${result.url}`);
		} catch (err) {
			setTunnelError(err instanceof Error ? err.message : "Failed to start tunnel");
		} finally {
			setTunnelBusy(false);
		}
	};

	const stopTunnel = async () => {
		setTunnelBusy(true);
		setTunnelError(null);
		try {
			await tunnelApi.stop();
			setTunnel({ running: false });
			toast.success("Tunnel stopped");
		} catch (err) {
			setTunnelError(err instanceof Error ? err.message : "Failed to stop tunnel");
		} finally {
			setTunnelBusy(false);
		}
	};

	return (
		<>
			<SettingsSection
				id="settings-password"
				title="Password Protection"
				description="Protect WebUI access with a password. It is kept in memory and resets when the server restarts."
			>
				<SettingsRow label="Status">
					<div className="flex items-center gap-3">
						<span aria-hidden className={`size-2.5 rounded-full ${isProtected ? "bg-green-500" : "bg-yellow-500"}`} />
						<span className="text-[13.5px]">{isProtected ? "Protected" : "Unprotected"}</span>
						{!isProtected && tunnel.running && <span className="text-xs text-destructive">Tunnel is active without a password</span>}
					</div>
				</SettingsRow>
				{!isProtected && (
					<SettingsRow label="Set password" htmlFor="settings-new-password">
						<div className="flex items-center gap-2">
							<Input
								id="settings-new-password"
								className="sm:w-60"
								type="password"
								value={newPassword}
								onChange={(e) => setNewPassword(e.target.value)}
								placeholder="Enter password"
								onKeyDown={(e) => {
									if (e.key === "Enter") void handleSetPassword();
								}}
							/>
							<Button icon={<Check />} onClick={() => void handleSetPassword()} disabled={!newPassword} loading={passwordBusy}>
								Set
							</Button>
						</div>
					</SettingsRow>
				)}
			</SettingsSection>

			<SettingsSection
				id="settings-tunnel"
				title="Cloudflare Tunnel"
				description="Expose this server to the internet through a Cloudflare Quick Tunnel."
			>
				<SettingsRow label="Status">
					<div className="flex items-center gap-3">
						<span aria-hidden className={`size-2.5 rounded-full ${tunnel.running ? "bg-green-500" : "bg-gray-400"}`} />
						<span className="text-[13.5px]">{tunnel.running ? "Running" : "Stopped"}</span>
					</div>
				</SettingsRow>
				{tunnel.running && tunnel.url && (
					<SettingsRow label="Public URL">
						<div className="flex items-center gap-2">
							<code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-[13px]">{tunnel.url}</code>
							<Button
								size="sm"
								variant="secondary"
								icon={<Copy />}
								aria-label="Copy tunnel URL"
								onClick={() => {
									void navigator.clipboard.writeText(tunnel.url as string);
									toast.success("URL copied");
								}}
							/>
						</div>
					</SettingsRow>
				)}
				{tunnelError && <p className="pt-1 text-sm text-destructive">{tunnelError}</p>}
				<SettingsRow label="Control">
					{tunnel.running ? (
						<Button variant="secondary" icon={<PowerOff />} onClick={() => void stopTunnel()} loading={tunnelBusy}>
							Stop Tunnel
						</Button>
					) : (
						<Button icon={<Power />} onClick={() => void startTunnel()} loading={tunnelBusy}>
							Start Tunnel
						</Button>
					)}
				</SettingsRow>
			</SettingsSection>

			{isProtected && (
				<DangerZone title="Danger zone">
					<SettingsRow label="Turn off protection" description="Anyone who can reach this server can open it until you set a new password">
						<Button variant="destructive" icon={<PowerOff />} onClick={() => void handleRemovePassword()} loading={passwordBusy}>
							Remove Password
						</Button>
					</SettingsRow>
				</DangerZone>
			)}
		</>
	);
}
