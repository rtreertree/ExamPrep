import { useRef, useState, type FormEvent } from "react";
import type { OwnershipInvitation, ShareSettings } from "../../shared/sharing";
import {
  Button,
  Dialog,
  ErrorNotice,
  Field,
  LoadingRows,
  Notice,
} from "../components/ui";
import { api, ApiError } from "../lib/api";
import { useResource } from "../lib/hooks";
import "./sharing.css";

export function SetSharing({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const path = `/sets/${id}/sharing`;
  const resource = useResource<ShareSettings>(path);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState("");
  const [error, setError] = useState<Error>();
  const [status, setStatus] = useState("");
  const [removing, setRemoving] = useState<ShareSettings["coOwners"][number]>();
  const linkField = useRef<HTMLInputElement>(null);
  const settings = resource.data;
  const link = settings?.link
    ? new URL(settings.link, window.location.origin).href
    : null;

  async function update(
    suffix: string,
    method: string,
    body: object,
    success: string,
    onSuccess?: () => void,
  ) {
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      resource.setData(await api<ShareSettings>(path + suffix, method, body));
      setStatus(success);
      onSuccess?.();
    } catch (error) {
      setError(error as Error);
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    setStatus("");
    try {
      await navigator.clipboard.writeText(link);
      setStatus("Link copied.");
    } catch {
      linkField.current?.focus();
      linkField.current?.select();
      setStatus("Link selected. Copy it from the field.");
    }
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    void update(
      "/invitations",
      "POST",
      { email },
      "Invitation ready in the recipient’s library.",
      () => setEmail(""),
    );
  }

  return (
    <Dialog title="Share and manage access" onClose={onClose}>
      <div className="stack sharing-dialog">
        <ErrorNotice error={resource.error} retry={resource.refresh} />
        {resource.loading && !settings ? (
          <LoadingRows label="Loading sharing settings" />
        ) : null}
        {settings ? (
          <>
            <section className="stack sharing-section">
              <h3>Copy link</h3>
              <p className="muted">
                Anyone with the link can sign in and copy the latest saved
                version, including answers.
              </p>
              {link ? (
                <>
                  <Field label="Copy link">
                    <input ref={linkField} readOnly value={link} />
                  </Field>
                  <div className="actions">
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void copyLink()}
                    >
                      Copy link
                    </Button>
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void update(
                          "/link",
                          "PUT",
                          { enabled: false },
                          "Copy link turned off.",
                        )
                      }
                    >
                      Turn off link
                    </Button>
                  </div>
                </>
              ) : (
                <div className="actions">
                  <Button
                    disabled={busy}
                    onClick={() =>
                      void update(
                        "/link",
                        "PUT",
                        { enabled: true },
                        "Copy link enabled.",
                      )
                    }
                  >
                    Enable copy link
                  </Button>
                </div>
              )}
            </section>
            <section className="stack sharing-section">
              <h3>Co-owners</h3>
              <p className="muted">
                Co-owners can edit and study this set. They accept the
                invitation in Exam Prep.
              </p>
              <form className="stack" onSubmit={invite}>
                <Field label="Co-owner email">
                  <input
                    type="email"
                    autoComplete="off"
                    maxLength={254}
                    required
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <div className="actions">
                  <Button type="submit" disabled={busy}>
                    Invite co-owner
                  </Button>
                </div>
              </form>
              {settings.coOwners.length || settings.invitations.length ? (
                <ul className="sharing-people">
                  {settings.coOwners.map((owner) => (
                    <li key={owner.id}>
                      <span>{owner.email}</span>
                      <Button
                        variant="quiet"
                        disabled={busy}
                        onClick={() => setRemoving(owner)}
                        aria-label={`Remove ${owner.email}`}
                      >
                        Remove
                      </Button>
                    </li>
                  ))}
                  {settings.invitations.map((invitation) => (
                    <li key={invitation.id}>
                      <span>
                        {invitation.email}
                        <small className="muted">Pending invitation</small>
                      </span>
                      <Button
                        variant="quiet"
                        disabled={busy}
                        aria-label={`Cancel invitation for ${invitation.email}`}
                        onClick={() =>
                          void update(
                            `/invitations/${invitation.id}`,
                            "DELETE",
                            {},
                            "Invitation canceled.",
                          )
                        }
                      >
                        Cancel
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {removing ? (
                <Notice tone="warning">
                  <p>
                    {removing.email} will lose access to this set. They’ll keep
                    their past attempts.
                  </p>
                  <div className="actions">
                    <Button
                      disabled={busy}
                      onClick={() => setRemoving(undefined)}
                    >
                      Keep co-owner
                    </Button>
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() =>
                        void update(
                          `/co-owners/${removing.id}`,
                          "DELETE",
                          {},
                          "Co-owner removed.",
                          () => setRemoving(undefined),
                        )
                      }
                    >
                      Remove co-owner
                    </Button>
                  </div>
                </Notice>
              ) : null}
            </section>
          </>
        ) : null}
        <ErrorNotice error={error} />
        <div role="status" className="muted">
          {status}
        </div>
      </div>
    </Dialog>
  );
}

export function OwnershipInvitations({ onAccept }: { onAccept: () => void }) {
  const resource = useResource<OwnershipInvitation[]>("/ownership-invitations");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<Error>();
  const [status, setStatus] = useState("");
  const invitations = resource.data ?? [];

  async function respond(invitation: OwnershipInvitation, accept: boolean) {
    setBusy(invitation.id);
    setError(undefined);
    setStatus("");
    try {
      await api(`/ownership-invitations/${invitation.id}/respond`, "POST", {
        accept,
      });
      resource.setData(invitations.filter(({ id }) => id !== invitation.id));
      setStatus(
        accept
          ? `You now co-own “${invitation.title}”.`
          : "Invitation declined.",
      );
      if (accept) onAccept();
    } catch (error) {
      setError(error as Error);
      if (error instanceof ApiError && error.status === 404) resource.refresh();
    } finally {
      setBusy(undefined);
    }
  }

  if (!invitations.length && !status && !error && !resource.error) return null;
  return (
    <section
      className="sharing-invitations stack"
      aria-label="Ownership invitations"
    >
      <h2>Ownership invitations</h2>
      <ErrorNotice
        error={error ?? resource.error}
        retry={resource.error ? resource.refresh : undefined}
      />
      {invitations.length ? (
        <ul className="sharing-people">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <span>
                <strong>{invitation.title}</strong>
                <small className="muted">
                  {invitation.kind === "exam" ? "Exam" : "Flashcards"} · Invited
                  by {invitation.ownerEmail}
                </small>
              </span>
              <div className="actions">
                <Button
                  disabled={!!busy}
                  onClick={() => void respond(invitation, false)}
                >
                  Decline
                </Button>
                <Button
                  variant="primary"
                  disabled={!!busy}
                  onClick={() => void respond(invitation, true)}
                >
                  Accept
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <div role="status">{status}</div>
    </section>
  );
}
