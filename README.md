# Photostrips

A small web app you run on your own CasaOS server and use from your phone.
Upload photos, arrange them in a strip, add a name and date, and download a
PDF with **6 photostrips** on one page (4 photos each, name and date at the
bottom), ready to print and cut.

- Works in your phone's browser (no app store needed).
- Protected by one password.
- Your photos stay on your phone. The server never receives them; the PDF is
  made right in the browser.
- Your work is kept on the phone, so closing the tab doesn't lose it. Tap
  **Start over** to clear it.

## Using it

1. **Add photos.** Tap *+ Add photos* and pick as many as you like. They fill
   the empty spots in order.
2. **Arrange.** Tap a photo in the strip to select it (it gets a yellow
   outline). Then:
   - drag to slide the photo around inside its frame,
   - pinch or tap *+ Zoom / − Zoom* to zoom,
   - tap *Up / Down* to change its place in the strip,
   - tap one of your photos at the top to swap it in,
   - tap *Done* when finished.
3. **Name and date.** Type the name, pick the date, and choose a lettering
   style and colors.
4. **Print.** By default all 6 strips use the same photos. Untick *Use the
   same photos on all 6 strips* to make each strip different (a *Strip 1–6*
   picker appears). Tap **Make PDF**.

When printing, choose **Actual size / 100%**, not "Fit to page". Six strips
don't fit on one sheet at the classic 2" × 6" size, so they're scaled down a
little: about 1.75" × 5.25" on US Letter and 1.87" × 5.6" on A4.

## Installing on CasaOS

### One-time setup on GitHub

Every time `main` changes, GitHub builds the app into a Docker image at
`ghcr.io/micah-naz/photostrip-generator`. Because this repository is private,
that image is private too, so CasaOS can't download it yet. The easiest fix:

1. Open your GitHub profile, go to **Packages**, and open
   `photostrip-generator`.
2. Click **Package settings**, scroll to **Danger Zone**, and choose
   **Change visibility → Public**.

The image only contains the app's code. It has no photos and no password in
it; your password is set on your server (next section).

### Install the app

1. Open CasaOS in your browser.
2. Click **App Store**, then the **+** button (Custom Install) in the top
   right, then **Import**.
3. Paste in the contents of [`docker-compose.yml`](docker-compose.yml).
4. Change `APP_PASSWORD` from `change-me` to a password of your own.
5. Click **Install**.
6. On your phone (on the same Wi-Fi), go to `http://<your-casaos-address>:8090`
   and log in. Tip: in Chrome, tap ⋮ → *Add to Home screen* so it opens like
   an app.

### Settings

| Setting        | What it does                                        | Default  |
| -------------- | --------------------------------------------------- | -------- |
| `APP_PASSWORD` | The password you log in with. Required.             | none     |
| `PAPER_SIZE`   | Starting paper size: `letter` or `a4`. You can also switch it in the app. | `letter` |
| Port `8090`    | The address port on your server. Change the left number in `ports` if 8090 is taken. | `8090` |

Changing the password logs you out on every device.

### Updating

After a change is merged into `main`, wait for the GitHub build to finish
(the green check on the commit), then in CasaOS open the app's settings and
click **Update** (or rebuild/restart it) so it downloads the new image.

## Running it on a computer (for developers)

```sh
npm install
APP_PASSWORD=test npm start
# open http://localhost:3000
```
