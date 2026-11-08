
const CLOUDINARY_CLOUD_NAME = "kvw56gnz";
const CLOUDINARY_UPLOAD_PRESET = "ML raw";

export async function uploadProfileImage(file) {
  if (!file) return "";

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(file.type)) {
    throw new Error("Choose JPG, PNG or WebP.");
  }

  if (file.size > 3 * 1024 * 1024) {
    throw new Error("Image must be 3 MB or smaller.");
  }

  const formData = new FormData();

  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", "magunga-profiles");

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
    {
      method: "POST",
      body: formData
    }
  );

  const result = await response.json();

  if (!response.ok || !result.secure_url) {
    throw new Error(
      result.error?.message || "Image upload failed."
    );
  }

  return result.secure_url;
}
