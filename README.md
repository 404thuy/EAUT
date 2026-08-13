# EAUT Student Schedule Web

Ung dung web don gian cho phep sinh vien dang nhap tai khoan EAUT va xem lich hoc.

## Cai dat

1. Cai Node.js 18+.
2. Tao file `.env` tu `.env.example`.
3. Cai thu vien:

```bash
npm install
```

## Chay ung dung

```bash
npm run dev
```

Mo trinh duyet tai `http://localhost:5000`.

## Luu y quan trong

- Ung dung su dung phien dang nhap cua chinh sinh vien (khong luu mat khau vao CSDL).
- Mac dinh truy cap trang dang nhap `https://qldt.eaut.edu.vn/congthongtin/login.aspx#diemhoc` (co fallback neu URL thay doi nhe).
- Cau truc HTML cua cong `qldt.eaut.edu.vn` co the thay doi. Khi do, can cap nhat parser trong `services/eautClient.js`.
- Neu cong yeu cau captcha/2FA, can bo sung buoc xac thuc tuong ung.
