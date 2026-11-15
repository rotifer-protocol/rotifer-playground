/**
 * The root CAs that sign Supabase's database and pooler certificates. Public
 * certificates, not secrets. The function passes them to the Postgres driver
 * so that a connection outside this machine checks the server's certificate
 * chain and host name (store.ts, databaseTls).
 *
 * Both are named "Supabase Root 2021 CA" but have different keys. Supabase's
 * own CLI pins the same two for hosted databases
 * (supabase/cli apps/cli/src/command-internal/supabase-ca-templates/).
 *
 * 2021: https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt
 *       (the file the dashboard's SSL settings link to; same bytes as the CLI's prod-ca-2021.ts)
 *       SHA-256 80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA
 *       valid 2021-04-28 to 2031-04-26
 * 2025: https://github.com/supabase/cli/blob/948d4d4e7444dbc44d46870c09ba290926512831/apps/cli/src/command-internal/supabase-ca-templates/prod-ca-2025.ts
 *       (not on the public download bucket; the dashboard link is the 2021 file)
 *       SHA-256 5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2
 *       valid 2025-09-03 to 2035-09-01
 *
 * On 2026-11-15 (UTC) the pooler (aws-1-us-west-1.pooler.supabase.com:6543) chained
 * to the 2021 root; the 2025 root alone did not verify it. The 2025 root is
 * carried for when Supabase moves to it, as the CLI does.
 *
 * db-tls.test.ts checks these fingerprints, and fails 60 days before either
 * certificate expires, each in its own test.
 */

export const SUPABASE_ROOT_CA_2021 = `-----BEGIN CERTIFICATE-----
MIIDxDCCAqygAwIBAgIUbLxMod62P2ktCiAkxnKJwtE9VPYwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTIxMDQyODEwNTY1M1oXDTMxMDQyNjEwNTY1M1ow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqQXW
QyHOB+qR2GJobCq/CBmQ40G0oDmCC3mzVnn8sv4XNeWtE5XcEL0uVih7Jo4Dkx1Q
DmGHBH1zDfgs2qXiLb6xpw/CKQPypZW1JssOTMIfQppNQ87K75Ya0p25Y3ePS2t2
GtvHxNjUV6kjOZjEn2yWEcBdpOVCUYBVFBNMB4YBHkNRDa/+S4uywAoaTWnCJLUi
cvTlHmMw6xSQQn1UfRQHk50DMCEJ7Cy1RxrZJrkXXRP3LqQL2ijJ6F4yMfh+Gyb4
O4XajoVj/+R4GwywKYrrS8PrSNtwxr5StlQO8zIQUSMiq26wM8mgELFlS/32Uclt
NaQ1xBRizkzpZct9DwIDAQABo2AwXjALBgNVHQ8EBAMCAQYwHQYDVR0OBBYEFKjX
uXY32CztkhImng4yJNUtaUYsMB8GA1UdIwQYMBaAFKjXuXY32CztkhImng4yJNUt
aUYsMA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQELBQADggEBAB8spzNn+4VU
tVxbdMaX+39Z50sc7uATmus16jmmHjhIHz+l/9GlJ5KqAMOx26mPZgfzG7oneL2b
VW+WgYUkTT3XEPFWnTp2RJwQao8/tYPXWEJDc0WVQHrpmnWOFKU/d3MqBgBm5y+6
jB81TU/RG2rVerPDWP+1MMcNNy0491CTL5XQZ7JfDJJ9CCmXSdtTl4uUQnSuv/Qx
Cea13BX2ZgJc7Au30vihLhub52De4P/4gonKsNHYdbWjg7OWKwNv/zitGDVDB9Y2
CMTyZKG3XEu5Ghl1LEnI3QmEKsqaCLv12BnVjbkSeZsMnevJPs1Ye6TjjJwdik5P
o/bKiIz+Fq8=
-----END CERTIFICATE-----
`;

export const SUPABASE_ROOT_CA_2025 = `-----BEGIN CERTIFICATE-----
MIIDxzCCAq+gAwIBAgIUeX+gpfmsRW9asFkRvjyXjHxbfgcwDQYJKoZIhvcNAQEL
BQAwazELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5l
dyBDYXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJh
c2UgUm9vdCAyMDIxIENBMB4XDTI1MDkwMzA4MDEyNVoXDTM1MDkwMTA4MDEyNVow
azELMAkGA1UEBhMCVVMxEDAOBgNVBAgMB0RlbHdhcmUxEzARBgNVBAcMCk5ldyBD
YXN0bGUxFTATBgNVBAoMDFN1cGFiYXNlIEluYzEeMBwGA1UEAwwVU3VwYWJhc2Ug
Um9vdCAyMDIxIENBMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA5Ve7
i9UAmc7luUilELPtqzEk8nGHxg7nY0aCStr625M7+K4OPO6RUllTsHh47k1jWyzm
LXLlyYwCsYCjQp+3vn06H+F/HRUxBt6CK2B7bNng230exTunk0xFvfkX6YgHR7B3
1B7L25Rq3PhuRFPV4hnGYRam2XBZC4UNPqoAgrhV0HOYzXXAVoTr2yaBTMnB331Z
RwOmINh7eqTCk/JRZbb6vfZOhZRAVAe9AoRLoG8aKwmeoLGwlu0UuFx6z3E+6bmA
fSNa8Lx02GEoCdPLw9IRKUFq/SgBpQUKm44H1fDwTjH2CMM0N4p0mL/6wXnNeHvt
C40MmKZ0RcVmHE5wBwIDAQABo2MwYTAdBgNVHQ4EFgQUjvEE541toZcwtXQlZlcB
YOBRTnowHwYDVR0jBBgwFoAUjvEE541toZcwtXQlZlcBYOBRTnowDwYDVR0TAQH/
BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAYYwDQYJKoZIhvcNAQELBQADggEBACD5IcGP
XKvS9qg0CgEQPFqYavt5c7P+0xxFgiZe+xoG8fUw58yNeK2APtgGPRpxEOGfAlNx
z9HDt4gcyHEE00B3qAVDm49pqNxioFWzNqU2LGfM/HL1QmN6urR7hCOkVCJddvOc
FhFX4nZDuRfaBboDvS5HlK3Pzxddp9hvrJi2bemr8HLqYc3HzmVckgPGSLML6t+h
4LRCXSlQsDgQ1LZ4KHsl4cq7K51N6FOXQBLB5q4lMKhs0VUhCT8Pdsj12+84laCV
c22q6p2mdT9SaernCSRnWazXWisgpjv3H7Ex4S1DCYjJIwn3PUToGFv1r8YRN2/S
O19yVSxxCIf64Sg=
-----END CERTIFICATE-----
`;

export const SUPABASE_ROOT_CAS: readonly string[] = [SUPABASE_ROOT_CA_2021, SUPABASE_ROOT_CA_2025];
