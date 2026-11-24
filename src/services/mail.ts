import nodemailer from "nodemailer";
import { config } from "../config";
import * as db from "../db";

const transport = config.smtpUrl ? nodemailer.createTransport(config.smtpUrl) : null;

/** Send mail, or record it in the dev outbox when SMTP isn't configured. */
export async function send({ to, subject, text, from = config.proposals.mailFrom }: { to: string; subject: string; text: string; from?: string }) {
  if (transport) {
    await transport.sendMail({ from, to, subject, text, replyTo: "simmons-request@mit.edu" });
  } else {
    await db.run("INSERT INTO outbox(to_addr,subject,body) VALUES ($1,$2,$3)", [to, subject, text]);
    console.log(`[mail:outbox] to=${to} subject=${subject}`);
  }
}
