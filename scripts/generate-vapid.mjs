import webpush from "web-push";

const vapidKeys = webpush.generateVAPIDKeys();

console.log("\n--- Generated VAPID Keys ---");
console.log(`VAPID_PUBLIC_KEY=${vapidKeys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${vapidKeys.privateKey}`);
console.log("VAPID_SUBJECT=mailto:admin@laztar.xyz\n");
console.log("Add these lines to your .env file.");
