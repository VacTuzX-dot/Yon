# Yon Link: send from your phone

iPhone and Android phones send photos and files to your computer through a small web page that Yon serves on your Wi-Fi. There is nothing to install from an app store. How it is protected: [Security](security.md#yon-link-phones).

## Pair a phone (once)

1. On the computer: **Settings → Phones → Pair a phone**, name the phone. A QR code appears.
2. On the phone: open the Camera, scan the code, tap the link. The phone must be on the same Wi-Fi.
3. Tap Share → **Add to Home Screen** (Android: menu ⋮ → Add to Home screen).

If the link doesn't open (some Android phones can't use `.local` names), tap **Link doesn't open?** under the QR code for a code that uses the computer's IP address instead.

## Send and receive

Tap the Yon icon on the phone.

| To send | How |
|---|---|
| Phone → computer | Choose photos or files, then accept on the computer. |
| Computer → phone | Your paired phones show up next to other computers in Yon. Pick one, choose files, and tap **Receive** on the phone (its Yon page has to be open, or opened within 10 minutes). Up to 1 GB at a time. |
| Phone → phone | When another paired phone has its Yon page open, it appears under **Send to**. The computer passes the files along (Yon must be running there) and the other phone taps **Receive**. |

Where received files go on a phone: in Safari, Files → Downloads. From the Home Screen icon, tap **Save** on each file, then Share → Save to Files (or Save Image/Video for photos and videos).

Keep the phone's screen on while a big file is sending or arriving. If the phone locks, the transfer continues from where it stopped when you come back, as long as it's within about 5 minutes.

## Reach from anywhere (optional)

By default the phone and computer must share a Wi-Fi network. To use them on different networks, turn on **Settings → Phones → Reach from anywhere**.

- New pairings open the phone page from <https://yon.meo.in.th/phonelink/> and reach the computer through a relay.
- Release builds come with a relay run by the maintainer. To use your own, enter it under **Settings → Advanced → Relay address**.
- The relay only passes on encrypted data and stores nothing. It does see internet addresses, when devices connect and how much they send.
- Phones paired before show **Pair again**: scan the new code. The old link keeps working until the phone connects with the new one.

### Run your own relay

```bash
cd relay && YON_RELAY_TAG=dev docker compose up -d --build
```

The relay listens on 127.0.0.1 only. Put Cloudflare Tunnel or another TLS proxy in front, then check the WebSocket path end to end:

```bash
bun relay/check.ts wss://<your host>
```

`.github/workflows/relay.yml` and `relay/deploy.sh` deploy it with health checks and rollback. `.github/workflows/website.yml` and `website/deploy.sh` do the same for the website.

## Use one phone with several computers

One Yon icon on your phone can keep up to 4 computers. Each computer keeps its own pairing. This works for computers paired with **Reach from anywhere** turned on.

### Add a computer

1. On the computer you want to add: **Settings → Phones → Pair a phone**. Leave the QR code on the screen.
2. On the phone, tap the Yon icon, then **Add computer**.
3. Point the phone's camera at the QR code. The computer is added and appears in the list.

If the code only works on the same Wi-Fi, Yon shows: "That code only works on the same Wi-Fi. Turn on Reach from anywhere in Yon on that computer, then show the code again."

- On Android, scanning a computer's code with the Camera app and opening the link also adds it. On iPhone the link opens in Safari, not in the Yon icon, so use **Add computer**.
- A phone can keep 4 computers. To add another, tap **Forget** on one first.

### Use several computers

- **Send to** lists each computer, the one you used last first. Computers the phone can't reach right now are greyed out. Phones that reach a computer appear as "<phone> (via <computer>)".
- Files you receive say which computer they came through.
- **Computers** at the top of the page lists each computer as **Online**, **Can't reach it**, or **Removed on <name>**.
- **Forget** removes a computer from this phone only. The phone stays paired on that computer. To cut the phone off there, remove it in that computer's **Settings → Phones**.
- A computer that shows **Removed on <name>** no longer has this phone paired. Forget it, or pair the phone again.

Pages opened on your home Wi-Fi only (without Reach from anywhere) still work with one computer each.
