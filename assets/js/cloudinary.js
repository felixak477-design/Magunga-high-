
const CLOUDINARY_CLOUD_NAME = "kvw56gnz";
const CLOUDINARY_UPLOAD_PRESET = "Images";

async function uploadImage(file, folder, maxSizeMB) {
  if (!file) throw new Error("Choose an image first.");

  const allowedTypes = [
    "image/jpeg",
    "image/png",
    "image/webp"
  ];

  if (!allowedTypes.includes(file.type)) {
    throw new Error("Choose JPG, PNG or WebP.");
  }

  if (file.size > maxSizeMB * 1024 * 1024) {
    throw new Error(`Image must be ${maxSizeMB} MB or smaller.`);
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("upload_preset", CLOUDINARY_UPLOAD_PRESET);
  formData.append("folder", folder);

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

export async function uploadProfileImage(file) {
  if (!file) return "";
  return uploadImage(file, "magunga-profiles", 3);
}

export async function uploadCommunityImage(file) {
  return uploadImage(file, "magunga-community", 5);
}
