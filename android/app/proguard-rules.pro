# Retrofit + OkHttp
-dontwarn okhttp3.**
-dontwarn okio.**
-keepattributes Signature, InnerClasses, EnclosingMethod
-keepclasseswithmembers class * {
    @retrofit2.http.* <methods>;
}

# kotlinx.serialization: generated serializers are referenced reflectively
-keepattributes *Annotation*, RuntimeVisibleAnnotations
-keep,includedescriptorclasses class com.friday.one.data.**$$serializer { *; }
-keepclassmembers class com.friday.one.data.** {
    *** Companion;
}
-keepclasseswithmembers class com.friday.one.data.** {
    kotlinx.serialization.KSerializer serializer(...);
}
