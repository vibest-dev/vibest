// A Pi session exports PI_PACKAGE_DIR. After a pix update that directory is gone, and a test that
// starts pi then reads version 0.0.0 and exits before herdr can see it. The install beside `pi` is the one to use.
delete process.env.PI_PACKAGE_DIR
