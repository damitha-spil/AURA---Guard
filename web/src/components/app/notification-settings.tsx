// Settings > Notifications.
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { notifySupported, setNotifyReplies, showNotification, useNotifyReplies } from "@/lib/notify";

export function NotificationSettings() {
  const on = useNotifyReplies();
  const supported = notifySupported();
  const [permission, setPermission] = React.useState<string>(() => (supported ? Notification.permission : "denied"));

  async function change(next: boolean) {
    if (!next) return setNotifyReplies(false);
    const answer = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setPermission(answer);
    if (answer === "granted") setNotifyReplies(true);
    else toast.error("This window did not allow notifications.");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>A notice when a chat reply finishes while you are in another window. It holds no chat text.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!supported ? (
          <p className="text-muted-foreground">This window does not support notifications.</p>
        ) : (
          <>
            <Label className="flex items-center gap-2">
              <Switch checked={on && permission === "granted"} onCheckedChange={change} />
              Notify me when a reply is ready
            </Label>
            {permission === "denied" && (
              <p className="text-muted-foreground text-xs">Notifications are blocked for this window. Allow them in the browser or Windows settings, then reload.</p>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={permission !== "granted"}
              onClick={() => {
                if (!showNotification("This is a test notice.")) toast.error("The notice could not be shown.");
              }}
            >
              Send a test notice
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
