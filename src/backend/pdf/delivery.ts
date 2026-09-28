/**
 * @file src/backend/pdf/delivery.ts
 * @description Direct, frictionless path to attach generated PDFs or Google Drive files
 * to outgoing emails via Gmail API, or upload to Drive + set public sharing + drop
 * a styled card & shareable link directly into the email body.
 */
import { buildRawMessage, type MimeAttachment } from "@/backend/gmail/mime";
import { GoogleApiClient } from "@/backend/google/core/client";
import { GoogleDriveClient } from "@/backend/google/drive";
import { GoogleScope } from "@/backend/lib/google-auth";
import { savePdfToDrive } from "./storage";

export interface EmailDeliveryOptions {
  to: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  cc?: string;
  bcc?: string;
  accountRef?: string; // defaults to "personal" or "workspace"

  // PDF payload (if sending newly generated PDF)
  pdfBytes?: Uint8Array;
  filename?: string;

  // Existing Drive file (if attaching an existing Drive file or doc)
  driveFileId?: string;

  // Delivery mode:
  // "mime-attachment" -> attached as raw binary MIME part in the email
  // "drive-link"      -> uploaded/shared on Drive with "anyone with link can view" & styled link injected
  // "both"            -> attached as MIME AND shareable link injected into body
  deliveryMode?: "mime-attachment" | "drive-link" | "both";
}

export interface EmailDeliveryResult {
  messageId: string;
  threadId: string;
  deliveryMode: string;
  attachedFilename?: string;
  driveShareUrl?: string;
}

export async function sendEmailWithAttachmentOrDriveLink(
  env: Env,
  options: EmailDeliveryOptions
): Promise<EmailDeliveryResult> {
  const accountRef = options.accountRef || "workspace";
  const deliveryMode = options.deliveryMode || "mime-attachment";
  const filename = options.filename || "document.pdf";

  let pdfBytes = options.pdfBytes;
  let driveShareUrl: string | undefined;

  const drive = new GoogleDriveClient(env, accountRef);

  // If a driveFileId was provided but no raw bytes, download or export it
  if (!pdfBytes && options.driveFileId) {
    const meta = await drive.getFileMetadata(options.driveFileId);
    if (meta.mimeType === "application/pdf") {
      const buf = await drive.downloadFile(options.driveFileId);
      pdfBytes = new Uint8Array(buf);
    } else {
      // Export Doc/Sheet/Slide to PDF
      const buf = await drive.exportFile(options.driveFileId, "application/pdf");
      pdfBytes = new Uint8Array(buf);
    }
    driveShareUrl = meta.webViewLink || `https://drive.google.com/file/d/${options.driveFileId}/view`;
  }

  // Handle Drive upload / link sharing if deliveryMode is "drive-link" or "both"
  if (deliveryMode === "drive-link" || deliveryMode === "both") {
    if (options.driveFileId && !driveShareUrl) {
      driveShareUrl = `https://drive.google.com/file/d/${options.driveFileId}/view?usp=sharing`;
      try {
        await drive.createPermission(options.driveFileId, {
          role: "reader",
          type: "anyone",
        });
      } catch (e) {
        console.warn("Could not set anyone permission:", e);
      }
    } else if (pdfBytes && !driveShareUrl) {
      // Upload the PDF to Drive with public link
      const driveUpload = await savePdfToDrive(env, {
        pdfBytes,
        filename,
        accountRef,
        sharingRole: "anyone-viewer",
      });
      driveShareUrl = driveUpload.driveUrl;
    }
  }

  // Compose body HTML & text
  let finalHtml = options.bodyHtml || `<p>${options.bodyText || ""}</p>`;
  let finalText = options.bodyText || "";

  if (driveShareUrl) {
    const driveCardHtml = `
<div style="margin: 20px 0; padding: 16px; border: 1px solid #e2e8f0; border-radius: 8px; background-color: #f8fafc; font-family: sans-serif;">
  <div style="font-weight: 600; font-size: 14px; color: #0f172a; margin-bottom: 4px;">📎 Shared Document: ${filename}</div>
  <div style="font-size: 12px; color: #64748b; margin-bottom: 12px;">Anyone with this link can view the document on Google Drive.</div>
  <a href="${driveShareUrl}" style="display: inline-block; background-color: #0284c7; color: #ffffff; text-decoration: none; padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 500;" target="_blank" rel="noopener noreferrer">View on Google Drive →</a>
</div>`;
    finalHtml = `${finalHtml}\n${driveCardHtml}`;
    finalText = `${finalText}\n\nShared Document (${filename}): ${driveShareUrl}`;
  }

  // Prepare attachments if deliveryMode is "mime-attachment" or "both"
  const mimeAttachments: MimeAttachment[] = [];
  if ((deliveryMode === "mime-attachment" || deliveryMode === "both") && pdfBytes) {
    mimeAttachments.push({
      filename,
      mimeType: "application/pdf",
      bytes: pdfBytes,
    });
  }

  // Build raw RFC822 message
  const rawBase64Url = buildRawMessage({
    to: options.to,
    cc: options.cc,
    bcc: options.bcc,
    subject: options.subject,
    text: finalText,
    html: finalHtml,
    attachments: mimeAttachments.length > 0 ? mimeAttachments : undefined,
  });

  // Send via Gmail REST API
  const client = new GoogleApiClient(env, accountRef);
  const sent = await client.request<{ id: string; threadId: string }>(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      body: { raw: rawBase64Url },
      scopes: [GoogleScope.Gmail, GoogleScope.GmailSend],
    }
  );

  return {
    messageId: sent.id,
    threadId: sent.threadId,
    deliveryMode,
    attachedFilename: mimeAttachments.length > 0 ? filename : undefined,
    driveShareUrl,
  };
}
