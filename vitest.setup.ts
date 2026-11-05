// A Pi install directory the parent exported may be gone by the time a child starts. A test that
// starts pi would then read version 0.0.0 and exit before herdr can see it. The install beside `pi` is the one to use.
delete process.env.PI_PACKAGE_DIR
