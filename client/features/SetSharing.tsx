import { useEffect, useRef, useState, type FormEvent } from "react";
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
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      let url = link;
      if (!url) {
        const settings = await api<ShareSettings>(path + "/link", "PUT", {
          enabled: true,
        });
        resource.setData(settings);
        url = new URL(settings.link!, window.location.origin).href;
      }
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        setStatus("Link selected. Copy it from the field.");
        return;
      }
      setStatus("Link copied.");
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (status === "Link selected. Copy it from the field.") {
      linkField.current?.focus();
      linkField.current?.select();
    }
  }, [status, link]);

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
              <h3>View-only link</h3>
              <p className="muted">
                {link && !settings.guestAccess
                  ? "Sign-in is required to open this link."
                  : "Anyone with the link can read without signing in."}{" "}
                Readers see the latest saved version, including answers.
              </p>
              {link ? (
                <>
                  <Field label="View-only link">
                    <input ref={linkField} readOnly value={link} />
                  </Field>
                  <div className="actions">
                    <Button
                      variant="primary"
                      disabled={busy}
                      onClick={() => void copyLink()}
                    >
                      Copy view-only link
                    </Button>
                    {!settings.guestAccess && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          void update(
                            "/link",
                            "PUT",
                            { enabled: true, allowGuests: true },
                            "Guests can now open this link.",
                          )
                        }
                      >
                        Allow guests
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        void update(
                          "/link",
                          "PUT",
                          { enabled: false },
                          "View-only link turned off.",
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
                    variant="primary"
                    disabled={busy}
                    onClick={() => void copyLink()}
                  >
                    Copy view-only link
                  </Button>
                </div>
              )}
            </section>
            <section className="stack sharing-section">
              <details>
                <summary>
                  Invite an editor
                  {settings.coOwners.length + settings.invitations.length > 0
                    ? ` (${settings.coOwners.length + settings.invitations.length})`
                    : ""}
                </summary>
                <p className="muted">
                  Editors can change the original set. They accept the
                  invitation in Exam Prep.
                </p>
                <form className="stack" onSubmit={invite}>
                  <Field label="Editor email">
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
                      Send invitation
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
                      {removing.email} will lose access to this set. They’ll
                      keep their past attempts.
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
              </details>
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

export function OwnershipInvitations({
  onAccept,
  invitations,
  onRemoved,
  refresh,
}: {
  onAccept: () => void;
  invitations: OwnershipInvitation[];
  onRemoved: (id: string) => void;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<Error>();
  const [status, setStatus] = useState("");

  async function respond(invitation: OwnershipInvitation, accept: boolean) {
    setBusy(invitation.id);
    setError(undefined);
    setStatus("");
    try {
      await api(`/ownership-invitations/${invitation.id}/respond`, "POST", {
        accept,
      });
      onRemoved(invitation.id);
      setStatus(
        accept
          ? `You now co-own “${invitation.title}”.`
          : "Invitation declined.",
      );
      if (accept) onAccept();
    } catch (error) {
      setError(error as Error);
      if (error instanceof ApiError && error.status === 404) refresh();
    } finally {
      setBusy(undefined);
    }
  }

  if (!invitations.length && !status && !error) return null;
  return (
    <section
      className="sharing-invitations stack"
      aria-label="Ownership invitations"
    >
      <h2>Ownership invitations</h2>
      <ErrorNotice error={error} />
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
