# ascidrive

A endless night drive in your terminal, all in plain ASCII. Driving localy needs nothing but node; the ssh server needs `npm install` first (it uses the ssh2 package).

## Run it

    npm start

or `node bin/drive.js`. If your terminal is slow try `--fps 30`, and `--seed N` gives you a diffrent road.

## SSH server

Let other people drive over ssh. Put the port and the users in `ascidrive.cnf`, one user per line:

    port=2828
    tom/password1
    anna/another secret

Then `chmod 600 ascidrive.cnf` and start it with `npm run server`. Lots of people can drive at the same time, everyone gets there own road. Connect with:

    ssh -p 2828 tom@yourhost

Users get the drive and nothing else: no shell, no commands, no file transfer, no port forwarding. q or closing the window ends it. You can add or remove users while it runs; changing the port needs a restart. The host key is made on first start in `ascidrive_host_key`, keep that file.

## Terminal size

You need atleast **120 columns x 60 rows**. If the window is smaller it just tells you to resize. Bigger is better, so go full screen and make the font small.

## Keys

| Key    | What it does                  |
|--------|-------------------------------|
| f      | go faster (hold it)           |
| s      | slow down (hold it)           |
| t      | drive in / out of a tunnel    |
| q      | quit                          |
| Ctrl-C | shows the keys for a few secs (it does NOT quit) |
